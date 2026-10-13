import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { MailDatabase, QUEUES, type Tx } from "./database.js";
import {
  BindingCreate,
  BindingUpdate,
  ImportRange,
  Matching,
  Pick,
  Principal,
  requireProject,
  fail,
  MailError,
  type Identity,
} from "./contracts.js";
import {
  type MailProvider,
  type ProviderFactory,
  validateConfig,
} from "./provider.js";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const constantEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const first = (r: any) => r.rows[0];
export class MailService {
  constructor(
    public db: MailDatabase,
    public providers: ProviderFactory,
    public options: {
      aiEnabled: boolean;
      deliveryEnabled: boolean;
      allowPrivate?: boolean;
    },
  ) {}
  async identity(token: string): Promise<Identity> {
    const row = first(
      await this.db.pool.query(
        `SELECT p.*,t.actor FROM mail_tokens t JOIN mail_principals p ON p.tenant=t.tenant AND p.user_id=t.user_id WHERE t.hash=$1 AND t.expires_at>now() AND p.enabled`,
        [hash(token)],
      ),
    );
    if (!row) fail("unauthorized", "A valid delegated token is required", 401);
    return {
      tenant: row.tenant,
      user: row.user_id,
      projects: row.projects,
      enabled: row.enabled,
      actor: row.actor,
      version: row.version,
    };
  }
  async setPrincipal(input: unknown) {
    const p = Principal.parse(input);
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))", [
        JSON.stringify([p.tenant, p.user]),
      ]);
      const old = first(
        await c.query(
          "SELECT * FROM mail_principals WHERE tenant=$1 AND user_id=$2 FOR UPDATE",
          [p.tenant, p.user],
        ),
      );
      if (old && p.version !== old.version)
        fail("version_conflict", "Supply the current principal version", 409);
      return first(
        await c.query(
          `INSERT INTO mail_principals(tenant,user_id,projects,enabled) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant,user_id) DO UPDATE SET projects=excluded.projects,enabled=excluded.enabled,version=mail_principals.version+1 RETURNING *`,
          [p.tenant, p.user, p.projects, p.enabled],
        ),
      );
    });
  }
  async issueToken(
    tenant: string,
    user: string,
    actor: string,
    seconds: number,
  ) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + seconds * 1000).toISOString();
    const result = await this.db.pool.query(
      `INSERT INTO mail_tokens(hash,tenant,user_id,actor,expires_at) SELECT $1,tenant,user_id,$4,$5 FROM mail_principals WHERE tenant=$2 AND user_id=$3 AND enabled`,
      [hash(token), tenant, user, actor, expires],
    );
    if (!result.rowCount)
      fail("principal_unavailable", "Register an active principal first", 404);
    return { token, expires_at: expires };
  }
  async revokeToken(token: string) {
    await this.db.pool.query("DELETE FROM mail_tokens WHERE hash=$1", [
      hash(token),
    ]);
  }
  async principal(c: Tx, tenant: string, owner: string) {
    const row = first(
      await c.query(
        "SELECT * FROM mail_principals WHERE tenant=$1 AND user_id=$2 AND enabled",
        [tenant, owner],
      ),
    );
    if (!row)
      fail("principal_revoked", "Mailbox owner is no longer authorized", 403);
    return {
      tenant: row.tenant,
      user: row.user_id,
      projects: row.projects,
      enabled: true,
    };
  }
  async account(p: Principal, id: string, c: PickQuery = this.db.pool) {
    const row = first(
      await c.query(
        "SELECT * FROM mail_accounts WHERE id=$1 AND tenant=$2 AND owner_id=$3",
        [id, p.tenant, p.user],
      ),
    );
    if (!row) fail("not_found", "Mailbox not found", 404);
    return row;
  }
  async binding(
    p: Principal,
    id: string,
    write = false,
    c: PickQuery = this.db.pool,
  ) {
    const row = first(
      await c.query(
        "SELECT * FROM mail_bindings WHERE id=$1 AND tenant=$2 AND owner_id=$3",
        [id, p.tenant, p.user],
      ),
    );
    if (!row) fail("not_found", "Binding not found", 404);
    requireProject(p, row.project_id, write);
    return row;
  }
  async event(
    c: Tx,
    b: { tenant: string; owner_id: string; project_id?: string },
    type: string,
    payload: object,
  ) {
    const sequence = first(
      await c.query(
        "UPDATE mail_event_sequence SET value=value+1 WHERE id=1 RETURNING value",
      ),
    ).value;
    await c.query(
      "INSERT INTO mail_events(sequence,event_id,tenant,owner_id,project_id,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        sequence,
        randomUUID(),
        b.tenant,
        b.owner_id,
        b.project_id ?? null,
        type,
        payload,
      ],
    );
  }
  async request<T>(
    p: Identity,
    route: string,
    key: string,
    input: unknown,
    fn: (c: Tx) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length > 200)
      fail(
        "idempotency_key_required",
        "Use an Idempotency-Key of 1–200 characters",
      );
    const fingerprint = hash(canonical(input));
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([p.tenant, p.user, route, key]),
      ]);
      const old = first(
        await c.query(
          "SELECT * FROM mail_requests WHERE tenant=$1 AND user_id=$2 AND route=$3 AND key=$4",
          [p.tenant, p.user, route, key],
        ),
      );
      if (old) {
        if (old.hash !== fingerprint)
          fail(
            "idempotency_conflict",
            "Key was used for a different request",
            409,
          );
        return old.result;
      }
      const result = await fn(c);
      await c.query("INSERT INTO mail_requests VALUES($1,$2,$3,$4,$5,$6)", [
        p.tenant,
        p.user,
        route,
        key,
        fingerprint,
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  presentAccount(a: any) {
    const { config, ...safe } = a;
    return safe;
  }
  async createAccount(
    p: Identity,
    input: unknown,
    key: string,
    trustedOAuth = false,
  ) {
    const config = await validateConfig(input, !!this.options.allowPrivate);
    if (!trustedOAuth && config.provider !== "imap")
      fail(
        "oauth_required",
        "Use a connection session for Gmail or Microsoft Graph",
      );
    return this.request(p, "accounts", key, config, async (c) => {
      const id = randomUUID();
      const existing = first(
        await c.query(
          "SELECT id FROM mail_accounts WHERE tenant=$1 AND owner_id=$2 AND lower(address)=lower($3)",
          [p.tenant, p.user, config.address],
        ),
      );
      if (existing)
        fail(
          "mailbox_exists",
          "Reconnect the existing mailbox instead of overwriting it",
          409,
        );
      await c.query(
        "INSERT INTO mail_accounts(id,tenant,owner_id,address,provider,config) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          p.tenant,
          p.user,
          config.address.toLowerCase(),
          config.provider,
          this.db.cipher.encrypt(JSON.stringify(config)),
        ],
      );
      const op = await this.operation(c, p, id, null, "verify", {});
      return { mailbox_id: id, operation_id: op.id, status: "queued" };
    });
  }
  async updateCredentials(p: Identity, id: string, input: unknown) {
    const parsed = z
      .object({
        version: z.number().int().positive(),
        config: z.unknown(),
      })
      .strict()
      .parse(input);
    const config = await validateConfig(
      parsed.config,
      !!this.options.allowPrivate,
    );
    const a = await this.account(p, id);
    if (
      config.provider !== "imap" ||
      a.provider !== "imap" ||
      config.address.toLowerCase() !== a.address
    )
      fail(
        "invalid_reauthorization",
        "Use OAuth for Gmail/Graph; an IMAP update must retain the mailbox address",
      );
    return this.db.tx(async (c) => {
      const updated = await c.query(
        "UPDATE mail_accounts SET config=$3,version=version+1,status='pending',error=null WHERE id=$1 AND version=$2",
        [id, parsed.version, this.db.cipher.encrypt(JSON.stringify(config))],
      );
      if (!updated.rowCount)
        fail(
          "version_conflict",
          "Mailbox changed; reload before updating",
          409,
        );
      return this.operation(c, p, id, null, "verify", {});
    });
  }
  async operation(
    c: Tx,
    p: Principal,
    account: string,
    binding: string | null,
    kind: string,
    input: object,
  ) {
    const id = randomUUID();
    await c.query(
      "INSERT INTO mail_operations(id,tenant,owner_id,account_id,binding_id,kind,input) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, p.tenant, p.user, account, binding, kind, input],
    );
    const job = await this.db.enqueue(c, QUEUES.operation, { id });
    await c.query("UPDATE mail_operations SET job_id=$2 WHERE id=$1", [
      id,
      job,
    ]);
    return { id, status: "queued" };
  }
  ensureMatching(m: z.infer<typeof Matching>) {
    if (m.mode === "ai" && !this.options.aiEnabled)
      fail(
        "ai_not_configured",
        "Configure the host AI and credits gateway before enabling AI matching",
        503,
      );
  }
  async createBinding(p: Identity, input: unknown, key: string) {
    const data = BindingCreate.parse(input);
    requireProject(p, data.project_id, true);
    await this.account(p, data.mailbox_id);
    this.ensureMatching(data.matching);
    return this.request(p, "bindings", key, data, async (c) => {
      const account = await this.account(p, data.mailbox_id, c);
      if (account.status !== "ready")
        fail("mailbox_not_ready", "Wait for mailbox verification", 409);
      if (
        data.folders.some(
          (f) => !account.folders.some((x: any) => x.path === f),
        )
      )
        fail("unknown_folder", "Choose folders returned by the mailbox");
      const id = randomUUID();
      await c.query(
        "INSERT INTO mail_bindings(id,tenant,owner_id,project_id,account_id,folders,matching,continuous) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          p.tenant,
          p.user,
          data.project_id,
          data.mailbox_id,
          JSON.stringify(data.folders),
          data.matching,
          data.continuous,
        ],
      );
      return { id, version: 1 };
    });
  }
  async updateBinding(p: Identity, id: string, input: unknown) {
    const data = BindingUpdate.parse(input);
    await this.binding(p, id, true);
    if (data.matching) this.ensureMatching(data.matching);
    return this.db.tx(async (c) => {
      const b = await this.binding(p, id, true, c);
      const row = first(
        await c.query(
          `UPDATE mail_bindings SET matching=$3,continuous=$4,enabled=$5,version=version+1,matching_version=matching_version+CASE WHEN matching<>$3::jsonb THEN 1 ELSE 0 END
        WHERE id=$1 AND version=$2 RETURNING *`,
          [
            id,
            data.version,
            data.matching ?? b.matching,
            data.continuous ?? b.continuous,
            data.enabled ?? b.enabled,
          ],
        ),
      );
      if (!row)
        fail(
          "version_conflict",
          "Binding changed; reload before updating",
          409,
        );
      if (row.matching_version !== b.matching_version)
        await c.query(
          "UPDATE mail_items SET status='needs_rematch',error=null WHERE binding_id=$1 AND status IN ('pending','retrying')",
          [id],
        );
      return row;
    });
  }
  async startImport(p: Identity, id: string, input: unknown, key: string) {
    const range = ImportRange.parse(input);
    await this.binding(p, id, true);
    if (Date.parse(range.to) > Date.now() + 60000)
      fail("future_range", "End time must not be in the future");
    return this.request(p, `import:${id}`, key, range, async (c) => {
      const b = await this.binding(p, id, true, c);
      if (!b.enabled)
        fail("binding_paused", "Resume the binding before importing", 409);
      return this.operation(c, p, b.account_id, id, "import", {
        ...range,
        version: b.version,
        folders: b.folders,
        matching: b.matching,
        origin: "backfill",
      });
    });
  }
  async listItems(
    p: Identity,
    id: string,
    query: {
      limit: number;
      cursor?: string;
      status?: string;
      operation?: string;
    },
  ) {
    await this.binding(p, id);
    let after = "";
    let boundary = new Date().toISOString();
    if (query.cursor) {
      let cur: any;
      try {
        cur = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      } catch {
        fail("invalid_cursor", "Invalid cursor");
      }
      if (
        cur.binding !== id ||
        cur.status !== (query.status ?? "") ||
        cur.operation !== (query.operation ?? "") ||
        typeof cur.after !== "string" ||
        !Number.isFinite(Date.parse(cur.boundary))
      )
        fail("invalid_cursor", "Cursor does not match this query");
      after = cur.after;
      boundary = cur.boundary;
    }
    const rows = (
      await this.db.pool.query(
        `SELECT m.id,m.summary,m.received_at,i.status AS match_status,i.result AS match_result,i.error AS match_error,s.id AS selection_id,s.status AS selection_status
      FROM mail_items i JOIN mail_messages m ON m.id=i.message_id LEFT JOIN mail_selections s ON s.binding_id=i.binding_id AND s.message_id=i.message_id
      WHERE i.binding_id=$1 AND m.id>$2 AND m.created_at<=$3 AND ($4='' OR i.status=$4)
      AND ($5='' OR EXISTS(SELECT 1 FROM mail_import_items ii WHERE ii.operation_id=$5 AND ii.message_id=m.id))
      ORDER BY m.id LIMIT $6`,
        [
          id,
          after,
          boundary,
          query.status ?? "",
          query.operation ?? "",
          query.limit + 1,
        ],
      )
    ).rows;
    const more = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    return {
      items,
      next_cursor: more
        ? Buffer.from(
            JSON.stringify({
              binding: id,
              status: query.status ?? "",
              operation: query.operation ?? "",
              boundary,
              after: items.at(-1).id,
            }),
          ).toString("base64url")
        : null,
      as_of: boundary,
    };
  }
  async getContent(p: Identity, binding: string, message: string) {
    const b = await this.binding(p, binding);
    const a = await this.account(p, b.account_id);
    const m = first(
      await this.db.pool.query(
        "SELECT m.* FROM mail_messages m JOIN mail_items i ON i.message_id=m.id WHERE i.binding_id=$1 AND m.id=$2",
        [binding, message],
      ),
    );
    if (!m) fail("not_found", "Message not found", 404);
    if (a.status !== "ready")
      fail(
        "mailbox_not_ready",
        "Reconnect this mailbox before reading content",
        409,
      );
    const lock = await this.db.pool.connect();
    let acquired = false;
    let provider: MailProvider | undefined;
    try {
      acquired = first(
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS locked",
          [a.id],
        ),
      ).locked;
      if (!acquired)
        throw new MailError(
          "mailbox_busy",
          "Mailbox is busy; retry shortly",
          409,
          true,
        );
      provider = await this.openProvider(a);
      return await provider.content(m.summary);
    } finally {
      if (provider) await provider.close().catch(() => {});
      if (acquired)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [
          a.id,
        ]);
      lock.release();
    }
  }
  async openProvider(a: any) {
    const config = JSON.parse(this.db.cipher.decrypt(a.config));
    let previous = a.config;
    return this.providers(config, async () => {
      const encrypted = this.db.cipher.encrypt(JSON.stringify(config));
      const result = await this.db.pool.query(
        "UPDATE mail_accounts SET config=$2 WHERE id=$1 AND config=$3",
        [a.id, encrypted, previous],
      );
      if (!result.rowCount)
        fail(
          "credentials_changed",
          "Credentials were changed concurrently",
          409,
        );
      previous = encrypted;
    });
  }
  async select(p: Identity, binding: string, input: unknown, key: string) {
    const data = Pick.parse(input);
    await this.binding(p, binding, true);
    // Persist intent first; only a human confirmation may initiate the import delivery.
    return this.request(p, `select:${binding}`, key, data, async (c) => {
      const b = await this.binding(p, binding, true, c);
      if (!b.enabled) fail("binding_paused", "Binding is paused", 409);
      const m = first(
        await c.query(
          "SELECT m.id FROM mail_messages m JOIN mail_items i ON i.message_id=m.id WHERE i.binding_id=$1 AND m.id=$2",
          [binding, data.message_id],
        ),
      );
      if (!m) fail("not_found", "Message not found", 404);
      const old = first(
        await c.query(
          "SELECT * FROM mail_selections WHERE binding_id=$1 AND message_id=$2",
          [binding, data.message_id],
        ),
      );
      if (old) {
        if (
          JSON.stringify(old.selection) !==
          JSON.stringify(JSON.parse(JSON.stringify(data)))
        ) {
          // JSONB key order is not significant.
          if (hash(canonical(old.selection)) !== hash(canonical(data)))
            fail(
              "selection_exists",
              "A different selection already exists for this message",
              409,
            );
        }
        return old;
      }
      return first(
        await c.query(
          "INSERT INTO mail_selections(id,binding_id,message_id,selection,selected_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [randomUUID(), binding, data.message_id, data, p.user],
        ),
      );
    });
  }
  async confirm(p: Identity, id: string) {
    if (p.actor !== "human")
      fail(
        "human_confirmation_required",
        "A user must confirm the selected resume content",
        403,
      );
    if (!this.options.deliveryEnabled)
      fail(
        "import_gateway_not_configured",
        "Configure the host project import gateway",
        503,
      );
    const s = first(
      await this.db.pool.query("SELECT * FROM mail_selections WHERE id=$1", [
        id,
      ]),
    );
    if (!s) fail("not_found", "Selection not found", 404);
    await this.binding(p, s.binding_id, true);
    if (s.status !== "draft") return s;
    const content = await this.getContent(p, s.binding_id, s.message_id);
    if (
      s.selection.attachment_indexes.some(
        (i: number) => !content.attachments[i],
      )
    )
      fail(
        "attachment_unavailable",
        "One selected attachment is no longer available",
        409,
      );
    return this.db.tx(async (c) => {
      const current = first(
        await c.query("SELECT * FROM mail_selections WHERE id=$1 FOR UPDATE", [
          id,
        ]),
      );
      const b = await this.binding(p, current.binding_id, true, c);
      if (!b.enabled) fail("binding_paused", "Binding is paused", 409);
      if (current.status !== "draft") return current;
      const job = await this.db.enqueue(c, QUEUES.delivery, { id });
      return first(
        await c.query(
          "UPDATE mail_selections SET status='queued',confirmed_at=now(),job_id=$2,evidence=$3 WHERE id=$1 RETURNING *",
          [id, job, contentEvidence(content, s.selection)],
        ),
      );
    });
  }
  async rematch(p: Identity, id: string, key: string) {
    const b = await this.binding(p, id, true);
    this.ensureMatching(b.matching);
    if (!b.enabled) fail("binding_paused", "Resume before matching", 409);
    return this.request(
      p,
      `rematch:${id}`,
      key,
      { version: b.matching_version },
      async (c) => {
        const rows = (
          await c.query(
            "SELECT i.*,m.content_hash AS current_hash FROM mail_items i JOIN mail_messages m ON m.id=i.message_id WHERE i.binding_id=$1 AND (i.match_version<>$2 OR i.status IN ('failed','needs_rematch')) FOR UPDATE OF i",
            [id, b.matching_version],
          )
        ).rows;
        for (const item of rows) {
          const status = b.matching.mode === "manual" ? "manual" : "pending";
          const job =
            status === "pending"
              ? await this.db.enqueue(c, QUEUES.match, {
                  id: `${id}/${item.message_id}`,
                  version: b.matching_version,
                  content_hash: item.current_hash,
                })
              : null;
          await c.query(
            "UPDATE mail_items SET match_version=$3,content_hash=$4,matching=$5,status=$6,result=null,error=null,job_id=$7 WHERE binding_id=$1 AND message_id=$2",
            [
              id,
              item.message_id,
              b.matching_version,
              item.current_hash,
              b.matching,
              status,
              job,
            ],
          );
        }
        return { queued: rows.length, matching_version: b.matching_version };
      },
    );
  }
  async disconnect(p: Identity, id: string, version: number) {
    await this.account(p, id);
    return this.db.tx(async (c) => {
      const a = first(
        await c.query("SELECT * FROM mail_accounts WHERE id=$1 FOR UPDATE", [
          id,
        ]),
      );
      if (a.version !== version)
        fail("version_conflict", "Mailbox changed; reload first", 409);
      await c.query(
        "UPDATE mail_accounts SET config=$2,status='disabled',version=version+1 WHERE id=$1",
        [id, this.db.cipher.encrypt("{}")],
      );
      await c.query(
        "UPDATE mail_bindings SET enabled=false,continuous=false,version=version+1 WHERE account_id=$1",
        [id],
      );
      await c.query(
        "UPDATE mail_operations SET status='cancelled' WHERE account_id=$1 AND status IN ('queued','running','retrying')",
        [id],
      );
      return { id, status: "disabled", remote_mail_deleted: false };
    });
  }
  async getOperation(p: Identity, id: string) {
    const row = first(
      await this.db.pool.query(
        "SELECT * FROM mail_operations WHERE id=$1 AND tenant=$2 AND owner_id=$3",
        [id, p.tenant, p.user],
      ),
    );
    if (!row) fail("not_found", "Operation not found", 404);
    if (row.binding_id) await this.binding(p, row.binding_id);
    return row;
  }
  async controlOperation(p: Identity, id: string, action: "cancel" | "retry") {
    const row = await this.getOperation(p, id);
    if (row.binding_id) {
      const binding = await this.binding(p, row.binding_id, true);
      if (action === "retry" && row.input.version !== binding.version)
        fail(
          "binding_changed",
          "Start a new import using the current binding settings",
          409,
        );
    }
    return this.db.tx(async (c) => {
      const current = first(
        await c.query("SELECT * FROM mail_operations WHERE id=$1 FOR UPDATE", [
          id,
        ]),
      );
      if (action === "cancel") {
        if (["succeeded", "cancelled"].includes(current.status)) return current;
        await this.db.boss.cancel(QUEUES.operation, current.job_id, {
          db: { executeSql: (sql, args) => c.query(sql, args) },
        });
        await c.query(
          "UPDATE mail_operations SET status='cancelled',updated_at=now() WHERE id=$1",
          [id],
        );
      } else {
        if (!["failed", "cancelled"].includes(current.status))
          fail(
            "not_retryable",
            "Only failed or cancelled operations can be retried",
            409,
          );
        const job = await this.db.enqueue(c, QUEUES.operation, { id });
        await c.query(
          "UPDATE mail_operations SET status='queued',error=null,job_id=$2,updated_at=now() WHERE id=$1",
          [id, job],
        );
      }
      return first(
        await c.query("SELECT * FROM mail_operations WHERE id=$1", [id]),
      );
    });
  }
}
type PickQuery = Pick<import("pg").Pool, "query">;
export function canonical(value: any): string {
  return JSON.stringify(value, function (_key, v) {
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v;
  });
}

export function contentEvidence(
  content: { text: string; attachments: { content: Buffer }[] },
  selection: any,
) {
  return {
    body: selection.include_body ? hash(content.text) : null,
    attachments: selection.attachment_indexes.map((index: number) => ({
      index,
      sha256: createHash("sha256")
        .update(content.attachments[index]!.content)
        .digest("hex"),
    })),
  };
}
