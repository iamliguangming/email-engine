import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobWithMetadata } from "pg-boss";
import { MailService, canonical, hash, contentEvidence } from "./service.js";
import {
  MailError,
  MatchResult,
  matchRules,
  requireProject,
} from "./contracts.js";
import { QUEUES, type Tx } from "./database.js";
import type { Gateway } from "./gateway.js";
const one = (r: any) => r.rows[0];
type Job = JobWithMetadata<{
  id: string;
  version?: number;
  content_hash?: string;
}>;
const safeError = (e: any) =>
  e instanceof MailError
    ? e.code
    : e.authenticationFailed
      ? "authentication_failed"
      : e.rateLimited
        ? "provider_rate_limited"
        : "provider_or_database_error";
export class MailWorker {
  constructor(
    public service: MailService,
    public gateway: Gateway,
  ) {}
  get db() {
    return this.service.db;
  }
  async start() {
    await this.db.boss.work(
      QUEUES.operation,
      { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const j of jobs) await this.runOperation(j as Job);
      },
    );
    await this.db.boss.work(
      QUEUES.match,
      { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const j of jobs) await this.runMatch(j as Job);
      },
    );
    await this.db.boss.work(
      QUEUES.delivery,
      { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const j of jobs) await this.runDelivery(j as Job);
      },
    );
    await this.db.boss.work(QUEUES.tick, async () => {
      await this.tick();
    });
    await this.db.boss.schedule(QUEUES.tick, "* * * * *");
  }
  async authorized(c: Tx, b: any) {
    const p = await this.service.principal(c, b.tenant, b.owner_id);
    requireProject(p, b.project_id, true);
    if (!b.enabled)
      throw new MailError("binding_paused", "Binding paused", 409);
    return p;
  }
  async liveAttempt(c: Tx, queue: string, j: Job) {
    const actual = await this.db.boss.getJobById(queue, j.id, {
      db: { executeSql: (sql, args) => c.query(sql, args) },
    });
    return actual?.state === "active" && actual.retryCount === j.retryCount;
  }
  async runOperation(j: Job) {
    const id = j.data.id;
    const connection = await this.db.pool.connect();
    let account: any;
    let provider: any;
    let locked = false;
    try {
      const op = one(
        await connection.query("SELECT * FROM mail_operations WHERE id=$1", [
          id,
        ]),
      );
      if (
        !op ||
        op.job_id !== j.id ||
        ["succeeded", "cancelled", "failed"].includes(op.status)
      )
        return;
      // Session lock serializes protocol access and OAuth rotation across processes, without an open transaction.
      locked = one(
        await connection.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS locked",
          [op.account_id],
        ),
      ).locked;
      if (!locked)
        throw new MailError(
          "mailbox_busy",
          "Another job uses this mailbox",
          409,
          true,
        );
      await this.db.tx(async (c) => {
        const p = await this.service.principal(c, op.tenant, op.owner_id);
        account = await this.service.account(p, op.account_id, c);
        if (account.status === "disabled")
          throw new MailError(
            "mailbox_disabled",
            "Mailbox was disconnected",
            409,
          );
        if (op.kind !== "verify" && account.status !== "ready")
          throw new MailError(
            "mailbox_not_ready",
            "Reconnect this mailbox before importing",
            409,
          );
        if (op.binding_id) {
          const b = await this.service.binding(p, op.binding_id, true, c);
          await this.authorized(c, b);
          if (b.version !== op.input.version)
            throw new MailError(
              "binding_changed",
              "Restart import with current matching settings",
              409,
            );
        }
        await c.query(
          "UPDATE mail_operations SET status='running',updated_at=now() WHERE id=$1 AND job_id=$2 AND status<>'cancelled'",
          [id, j.id],
        );
      });
      provider = await this.service.openProvider(account);
      if (op.kind === "verify") {
        const folders = await provider.verify();
        await this.db.tx(async (c) => {
          const current = one(
            await c.query(
              "SELECT * FROM mail_operations WHERE id=$1 FOR UPDATE",
              [id],
            ),
          );
          if (
            current.status === "cancelled" ||
            current.job_id !== j.id ||
            !(await this.liveAttempt(c, QUEUES.operation, j))
          )
            return;
          await this.service.principal(c, op.tenant, op.owner_id);
          const freshAccount = one(
            await c.query(
              "SELECT version,status FROM mail_accounts WHERE id=$1 FOR UPDATE",
              [account.id],
            ),
          );
          if (
            freshAccount.version !== account.version ||
            freshAccount.status === "disabled"
          )
            throw new MailError(
              "credentials_changed",
              "Mailbox credentials changed; verify again",
              409,
            );
          await c.query(
            "UPDATE mail_accounts SET status='ready',error=null,folders=$2 WHERE id=$1",
            [account.id, JSON.stringify(folders)],
          );
          await c.query(
            "UPDATE mail_operations SET status='succeeded',updated_at=now() WHERE id=$1",
            [id],
          );
          await this.service.event(c, account, "mailbox.ready", {
            mailbox_id: account.id,
            operation_id: id,
          });
        });
        return;
      }
      const page = await provider.scan(
        { from: op.input.from, to: op.input.to, folders: op.input.folders },
        op.cursor,
      );
      await this.db.tx(async (c) => {
        const current = one(
          await c.query(
            "SELECT * FROM mail_operations WHERE id=$1 FOR UPDATE",
            [id],
          ),
        );
        if (
          current.status === "cancelled" ||
          current.job_id !== j.id ||
          !(await this.liveAttempt(c, QUEUES.operation, j))
        )
          return;
        const p = await this.service.principal(c, op.tenant, op.owner_id);
        const b = await this.service.binding(p, op.binding_id, true, c);
        await this.authorized(c, b);
        if (b.version !== op.input.version)
          throw new MailError(
            "binding_changed",
            "Binding was changed during import",
            409,
          );
        let added = 0;
        for (const m of page.messages) {
          if (
            m.date < op.input.from ||
            m.date >= op.input.to ||
            !m.folderPaths.some((f: string) => op.input.folders.includes(f))
          )
            continue;
          const remoteKey =
            account.provider === "imap"
              ? `${m.folderPaths[0]}:${m.ref}`
              : m.ref;
          const mid = hash(`${account.id}\n${remoteKey}`);
          const digest = hash(
            canonical({
              subject: m.subject,
              from: m.from,
              to: m.to,
              snippet: m.snippet,
              hasAttachments: m.hasAttachments,
            }),
          );
          await c.query(
            `INSERT INTO mail_messages(id,account_id,remote_key,summary,received_at,content_hash) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(account_id,remote_key) DO UPDATE SET summary=excluded.summary,received_at=excluded.received_at,content_hash=excluded.content_hash`,
            [mid, account.id, remoteKey, m, m.date, digest],
          );
          added +=
            (
              await c.query(
                "INSERT INTO mail_import_items VALUES($1,$2) ON CONFLICT DO NOTHING",
                [id, mid],
              )
            ).rowCount ?? 0;
          const existing = one(
            await c.query(
              "SELECT * FROM mail_items WHERE binding_id=$1 AND message_id=$2 FOR UPDATE",
              [b.id, mid],
            ),
          );
          if (
            existing &&
            existing.match_version === b.matching_version &&
            existing.content_hash === digest
          )
            continue;
          const status = b.matching.mode === "manual" ? "manual" : "pending";
          await c.query(
            `INSERT INTO mail_items(binding_id,message_id,match_version,content_hash,matching,status) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(binding_id,message_id) DO UPDATE SET match_version=excluded.match_version,content_hash=excluded.content_hash,matching=excluded.matching,status=excluded.status,result=null,error=null,job_id=null`,
            [b.id, mid, b.matching_version, digest, b.matching, status],
          );
          if (status === "pending") {
            const job = await this.db.enqueue(c, QUEUES.match, {
              id: `${b.id}/${mid}`,
              version: b.matching_version,
              content_hash: digest,
            });
            await c.query(
              "UPDATE mail_items SET job_id=$3 WHERE binding_id=$1 AND message_id=$2",
              [b.id, mid, job],
            );
          }
          await this.service.event(c, b, "mail.discovered", {
            binding_id: b.id,
            message_id: mid,
            operation_id: id,
            origin: op.input.origin,
          });
        }
        let nextJob = null;
        if (page.next !== null)
          nextJob = await this.db.enqueue(c, QUEUES.operation, { id });
        await c.query(
          "UPDATE mail_operations SET status=$2,cursor=$3,scanned=scanned+$4,indexed=indexed+$5,job_id=COALESCE($6,job_id),error=null,updated_at=now() WHERE id=$1",
          [
            id,
            page.next === null ? "succeeded" : "queued",
            page.next,
            page.messages.length,
            added,
            nextJob,
          ],
        );
        if (page.next === null) {
          if (op.input.origin === "live")
            await c.query(
              "UPDATE mail_bindings SET watermark=GREATEST(watermark,$2) WHERE id=$1",
              [b.id, op.input.to],
            );
          await this.service.event(c, b, "import.completed", {
            operation_id: id,
            binding_id: b.id,
            indexed: current.indexed + added,
          });
        }
      });
    } catch (e) {
      await this.failure(QUEUES.operation, j, e, "mail_operations", "id=$1", [
        id,
      ]);
      if (account && j.retryCount >= j.retryLimit)
        await this.db.pool.query(
          "UPDATE mail_accounts SET error=$2,status=CASE WHEN $2='authentication_failed' THEN 'auth_required' ELSE status END WHERE id=$1",
          [account.id, safeError(e)],
        );
      throw new Error(safeError(e));
    } finally {
      if (provider) await provider.close().catch(() => {});
      if (locked)
        await connection.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,1))",
          [
            account?.id ??
              one(
                await connection.query(
                  "SELECT account_id FROM mail_operations WHERE id=$1",
                  [id],
                ),
              )?.account_id,
          ],
        );
      connection.release();
    }
  }
  async failure(
    queue: string,
    j: Job,
    e: unknown,
    table: string,
    where: string,
    params: unknown[],
  ) {
    const terminal =
      j.retryCount >= j.retryLimit || (e instanceof MailError && !e.retryable);
    await this.db.tx(async (c) => {
      if (!(await this.liveAttempt(c, queue, j))) return;
      await c.query(
        `UPDATE ${table} SET status=$${params.length + 1},error=$${params.length + 2} WHERE ${where} AND job_id=$${params.length + 3} AND status NOT IN ('cancelled','succeeded','delivered')`,
        [...params, terminal ? "failed" : "retrying", safeError(e), j.id],
      );
    });
  }
  async runMatch(j: Job) {
    const [binding, mid] = j.data.id.split("/") as [string, string];
    try {
      const row = await this.db.tx(async (c) => {
        const b = one(
          await c.query("SELECT * FROM mail_bindings WHERE id=$1", [binding]),
        );
        if (!b) return null;
        await this.authorized(c, b);
        const item = one(
          await c.query(
            "SELECT i.*,m.summary FROM mail_items i JOIN mail_messages m ON m.id=i.message_id WHERE binding_id=$1 AND message_id=$2",
            [binding, mid],
          ),
        );
        if (
          !item ||
          item.job_id !== j.id ||
          item.status === "failed" ||
          item.match_version !== b.matching_version ||
          item.content_hash !== j.data.content_hash
        )
          return null;
        return { b, item };
      });
      if (!row) return;
      const { b, item } = row;
      let result: any;
      if (item.matching.mode === "rules")
        result = { ...matchRules(item.matching, item.summary), credits: 0 };
      else {
        result = MatchResult.parse(
          await this.gateway(
            "match",
            `match:${binding}:${mid}:${item.match_version}:${item.content_hash}`,
            {
              tenant_id: b.tenant,
              user_id: b.owner_id,
              project_id: b.project_id,
              binding_id: binding,
              message_id: mid,
              instructions: item.matching.ai_prompt,
              message: item.summary,
              content_scope: "metadata_and_snippet",
              billing_policy: "charge_once_per_idempotency_key",
            },
          ),
        );
      }
      await this.db.tx(async (c) => {
        const fresh = one(
          await c.query("SELECT * FROM mail_bindings WHERE id=$1", [binding]),
        );
        await this.authorized(c, fresh);
        if (
          fresh.matching_version !== item.match_version ||
          !(await this.liveAttempt(c, QUEUES.match, j))
        )
          return;
        const updated = await c.query(
          "UPDATE mail_items SET status=$3,result=$4,error=null WHERE binding_id=$1 AND message_id=$2 AND job_id=$5 AND content_hash=$6",
          [
            binding,
            mid,
            result.matched ? "matched" : "unmatched",
            result,
            j.id,
            item.content_hash,
          ],
        );
        if (updated.rowCount)
          await this.service.event(c, b, "mail.matched", {
            binding_id: binding,
            message_id: mid,
            matched: result.matched,
          });
      });
    } catch (e) {
      await this.failure(
        QUEUES.match,
        j,
        e,
        "mail_items",
        "binding_id=$1 AND message_id=$2",
        [binding, mid],
      );
      throw new Error(safeError(e));
    }
  }
  async runDelivery(j: Job) {
    try {
      const row = await this.db.tx(async (c) => {
        const s = one(
          await c.query("SELECT * FROM mail_selections WHERE id=$1", [
            j.data.id,
          ]),
        );
        if (
          !s ||
          s.job_id !== j.id ||
          !s.confirmed_at ||
          ["delivered", "failed"].includes(s.status)
        )
          return null;
        const b = one(
          await c.query("SELECT * FROM mail_bindings WHERE id=$1", [
            s.binding_id,
          ]),
        );
        const p = await this.authorized(c, b);
        return { s, b, p };
      });
      if (!row) return;
      const { s, b, p } = row;
      const content = await this.service.getContent(
        { ...p, actor: "human" },
        b.id,
        s.message_id,
      );
      const attachments = s.selection.attachment_indexes.map((i: number) => {
        const a = content.attachments[i];
        if (!a)
          throw new MailError(
            "attachment_unavailable",
            "Selected attachment is unavailable",
            410,
          );
        return {
          index: i,
          filename: a.filename,
          content_type: a.contentType,
          content_base64: a.content.toString("base64"),
          sha256: createHash("sha256").update(a.content).digest("hex"),
        };
      });
      if (
        canonical(contentEvidence(content, s.selection)) !==
        canonical(s.evidence)
      )
        throw new MailError(
          "selection_content_changed",
          "Selected content changed; user confirmation is required",
          409,
        );
      const result = z
        .object({
          status: z.enum(["accepted", "completed"]),
          import_id: z.string().min(1),
        })
        .parse(
          await this.gateway("import", `selection:${s.id}`, {
            tenant_id: b.tenant,
            user_id: b.owner_id,
            project_id: b.project_id,
            selection_id: s.id,
            message_id: s.message_id,
            confirmed_at: s.confirmed_at,
            text: s.selection.include_body ? content.text : null,
            attachments,
          }),
        );
      await this.db.tx(async (c) => {
        if (!(await this.liveAttempt(c, QUEUES.delivery, j))) return;
        await c.query(
          "UPDATE mail_selections SET status='delivered',result=$2,error=null WHERE id=$1 AND job_id=$3",
          [s.id, result, j.id],
        );
        await this.service.event(c, b, "selection.delivered", {
          selection_id: s.id,
          project_id: b.project_id,
          import_id: result.import_id,
          host_status: result.status,
        });
      });
    } catch (e) {
      await this.failure(QUEUES.delivery, j, e, "mail_selections", "id=$1", [
        j.data.id,
      ]);
      throw new Error(safeError(e));
    }
  }
  async tick() {
    await this.db.tx(async (c) => {
      // A process killed before its catch block must still reach a visible terminal state.
      for (const [table, queue] of [
        ["mail_operations", QUEUES.operation],
        ["mail_items", QUEUES.match],
        ["mail_selections", QUEUES.delivery],
      ]) {
        await c.query(
          `UPDATE ${table} r SET status='failed',error=COALESCE(r.error,'worker_attempts_exhausted') WHERE r.status IN ('queued','running','pending','retrying') AND r.job_id IS NOT NULL AND (EXISTS(SELECT 1 FROM mail_jobs.job j WHERE j.name=$1 AND j.id=r.job_id AND j.state IN ('failed','cancelled')) OR NOT EXISTS(SELECT 1 FROM mail_jobs.job j WHERE j.name=$1 AND j.id=r.job_id))`,
          [queue],
        );
      }
      const bindings = (
        await c.query(`SELECT b.* FROM mail_bindings b JOIN mail_principals p ON p.tenant=b.tenant AND p.user_id=b.owner_id
        WHERE b.enabled AND b.continuous AND p.enabled AND p.projects->>b.project_id='write'
        AND NOT EXISTS(SELECT 1 FROM mail_operations o WHERE o.binding_id=b.id AND o.input->>'origin'='live' AND o.status IN ('queued','running','retrying','failed') AND (o.status<>'failed' OR (o.input->>'version')::integer=b.version))
        FOR UPDATE OF b SKIP LOCKED`)
      ).rows;
      for (const b of bindings) {
        const to = new Date().toISOString();
        const from = new Date(
          new Date(b.watermark).getTime() - 600000,
        ).toISOString();
        await this.service.operation(
          c,
          {
            tenant: b.tenant,
            user: b.owner_id,
            projects: { [b.project_id]: "write" },
            enabled: true,
          },
          b.account_id,
          b.id,
          "import",
          {
            from,
            to,
            version: b.version,
            folders: b.folders,
            matching: b.matching,
            origin: "live",
          },
        );
      }
    });
  }
}
