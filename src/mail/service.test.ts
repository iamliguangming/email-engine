import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MailDatabase, QUEUES } from "./database.js";
import { MailService } from "./service.js";
import { mailApi } from "./api.js";
import { ConnectionSessions } from "./oauth.js";
import { MailWorker } from "./worker.js";
import { Matching, matchRules, MailError } from "./contracts.js";
import type { ProviderFactory } from "./provider.js";
const dbUrl = process.env.MAIL_TEST_DATABASE_URL;
const secret = "test-only-mail-secret-32-characters-long";
const admin = "test-only-admin-token-32-characters-long";
const wait = async (fn: () => Promise<any>) => {
  for (let i = 0; i < 600; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for worker");
};
test("rule matching handles Chinese normalization, any/all, attachments and strict inputs", () => {
  const rule = Matching.parse({
    mode: "rules",
    rules: [
      { field: "subject", operator: "contains", value: "简历" },
      { field: "has_attachment", operator: "equals", value: "true" },
    ],
  });
  assert.equal(
    matchRules(rule, { subject: "应聘简历", hasAttachments: true }).matched,
    true,
  );
  assert.equal(
    matchRules(rule, { subject: "应聘简历", hasAttachments: false }).matched,
    false,
  );
  assert.throws(() => Matching.parse({ mode: "rules", rules: [] }));
  assert.throws(() =>
    Matching.parse({
      mode: "rules",
      rules: [{ field: "has_attachment", operator: "contains", value: "yes" }],
    }),
  );
});
test(
  "PostgreSQL service: four-step intake, durable queues, isolation, billing and MCP",
  {
    skip:
      !dbUrl && "Set MAIL_TEST_DATABASE_URL to an isolated PostgreSQL instance",
  },
  async (t) => {
    const setup = new pg.Pool({ connectionString: dbUrl });
    const name = `mail_test_${Date.now()}`;
    await setup.query(`CREATE DATABASE ${name}`);
    const u = new URL(dbUrl!);
    u.pathname = `/${name}`;
    let db = new MailDatabase(u.toString(), secret);
    await db.start();
    let calls = 0,
      scanFailure = false,
      imports = 0,
      charges = 0,
      loseMatchAck = false,
      loseImportAck = false;
    const receipts = new Map<string, any>();
    const deliveries = new Map<string, any>();
    const message = (ref: string, subject: string, date: string) => ({
      ref,
      subject,
      date,
      folderPaths: ["INBOX"],
      from: { address: "candidate@example.test" },
      to: [{ address: "owner@example.test" }],
      cc: [],
      size: 10,
      hasAttachments: true,
      snippet: "Application",
      headerMessageId: ref,
      inReplyTo: null,
      references: [],
      authResults: null,
      threadHint: null,
      flags: { seen: false, flagged: false, answered: false, draft: false },
    });
    const mail = [
      message("first", "工程师简历", "2026-01-05T00:00:00.000Z"),
      message("second", "广告", "2026-01-06T00:00:00.000Z"),
      message("third", "产品简历", "2026-01-07T00:00:00.000Z"),
    ];
    const providers: ProviderFactory = async () => ({
      async verify() {
        return [{ path: "INBOX", name: "Inbox", role: "inbox" }];
      },
      async scan(range, cursor) {
        calls++;
        if (scanFailure && cursor)
          throw new MailError("upstream_busy", "Retry", 503, true);
        const available = mail.filter(
          (m) => m.date >= range.from && m.date < range.to,
        );
        const start = Number(cursor ?? 0);
        return {
          messages: available.slice(start, start + 2),
          next: start + 2 < available.length ? String(start + 2) : null,
        };
      },
      async content() {
        return {
          text: "Resume body",
          attachments: [
            {
              filename: "resume.pdf",
              contentType: "application/pdf",
              content: Buffer.from("synthetic resume"),
            },
          ],
        };
      },
      async close() {},
    });
    const gateway = async (
      kind: "match" | "import",
      key: string,
      payload: any,
    ) => {
      if (kind === "match") {
        if (!receipts.has(key)) {
          charges++;
          receipts.set(key, {
            matched: payload.message.subject.includes("简历"),
            reason: "mock classifier",
            charge_id: `charge-${charges}`,
            credits: 1,
          });
        }
        if (loseMatchAck) {
          loseMatchAck = false;
          throw new Error("response lost after committed charge");
        }
        return receipts.get(key);
      }
      if (!deliveries.has(key)) {
        imports++;
        assert.equal(payload.attachments[0].filename, "resume.pdf");
        deliveries.set(key, {
          status: "accepted",
          import_id: `project-import-${imports}`,
        });
      }
      if (loseImportAck) {
        loseImportAck = false;
        throw new Error("response lost after accepted import");
      }
      return deliveries.get(key);
    };
    let service = new MailService(db, providers, {
      allowPrivate: true,
      aiEnabled: true,
      deliveryEnabled: true,
    });
    let app = mailApi(service, admin);
    const req = async (
      path: string,
      token: string,
      method = "GET",
      body?: unknown,
      key = "test-key",
    ) => {
      const r = await app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    let human = "",
      agent = "",
      other = "",
      readonly = "",
      mailbox = "",
      binding = "",
      operation = "",
      selection = "";
    const range = { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" };
    try {
      await service.setPrincipal({
        tenant: "t1",
        user: "u1",
        projects: { p1: "write", p2: "write" },
      });
      await service.setPrincipal({
        tenant: "t2",
        user: "u2",
        projects: { p1: "write" },
      });
      human = (await service.issueToken("t1", "u1", "human", 3600)).token;
      agent = (await service.issueToken("t1", "u1", "agent", 3600)).token;
      other = (await service.issueToken("t2", "u2", "human", 3600)).token;
      await t.test(
        "no admin authority through the business API; token revocation and restricted administration",
        async () => {
          assert.equal((await req("/v1/mailboxes", admin)).status, 401);
          assert.equal(
            (
              await req("/admin/principals", human, "PUT", {
                tenant: "t2",
                user: "x",
                projects: {},
              })
            ).status,
            401,
          );
          const temporary = (await service.issueToken("t1", "u1", "agent", 60))
            .token;
          await service.revokeToken(temporary);
          assert.equal((await req("/v1/mailboxes", temporary)).status, 401);
        },
      );
      await t.test(
        "mailbox create is asynchronous, encrypted and idempotent; restart preserves queued work",
        async () => {
          const config = {
            provider: "imap",
            address: "owner@example.test",
            imap: {
              host: "localhost",
              port: 993,
              secure: true,
              user: "owner",
              pass: "not-a-real-password",
            },
          };
          const result = await req(
            "/v1/mailboxes",
            human,
            "POST",
            config,
            "connect",
          );
          assert.equal(result.status, 202);
          mailbox = result.body.mailbox_id;
          assert.equal(
            (await req("/v1/mailboxes", human, "POST", config, "connect")).body
              .mailbox_id,
            mailbox,
          );
          assert.equal(
            (
              await req(
                "/v1/mailboxes",
                human,
                "POST",
                { ...config, address: "second@example.test" },
                "connect",
              )
            ).status,
            409,
          );
          const stored = (
            await db.pool.query(
              "SELECT config FROM mail_accounts WHERE id=$1",
              [mailbox],
            )
          ).rows[0].config;
          assert.ok(stored.startsWith("enc1:"));
          assert.ok(!stored.includes("not-a-real-password"));
          await db.stop();
          db = new MailDatabase(u.toString(), secret);
          await db.start();
          for (const queue of Object.values(QUEUES))
            await db.boss.updateQueue(queue, { retryDelay: 0 });
          service = new MailService(db, providers, {
            allowPrivate: true,
            aiEnabled: true,
            deliveryEnabled: true,
          });
          app = mailApi(service, admin);
          await new MailWorker(service, gateway).start();
          await wait(async () => {
            const a = await service.account(
              await service.identity(human),
              mailbox,
            );
            return a.status === "ready";
          });
          const visible = await req(`/v1/mailboxes/${mailbox}`, human);
          assert.equal(visible.body.config, undefined);
          assert.equal(visible.body.folders[0].path, "INBOX");
          assert.equal(
            (await req(`/v1/mailboxes/${mailbox}`, other)).status,
            404,
          );
        },
      );
      await t.test(
        "bind project, range import, per-message matching; no automatic resume import",
        async () => {
          const input = {
            mailbox_id: mailbox,
            project_id: "p1",
            folders: ["INBOX"],
            matching: {
              mode: "rules",
              rules: [
                { field: "subject", operator: "contains", value: "简历" },
              ],
            },
          };
          const b = await req("/v1/bindings", human, "POST", input, "bind");
          assert.equal(b.status, 201);
          binding = b.body.id;
          assert.equal(
            (
              await req(
                "/v1/bindings",
                human,
                "POST",
                { ...input, project_id: "denied" },
                "bad",
              )
            ).status,
            403,
          );
          assert.equal(
            (await req("/v1/bindings", other, "POST", input, "bad")).status,
            404,
          );
          const task = await req(
            `/v1/bindings/${binding}/imports`,
            human,
            "POST",
            range,
            "import",
          );
          assert.equal(task.status, 202);
          operation = task.body.id;
          assert.equal(
            (
              await req(
                `/v1/bindings/${binding}/imports`,
                human,
                "POST",
                range,
                "import",
              )
            ).body.id,
            operation,
          );
          await wait(async () => {
            const op = await service.getOperation(
              await service.identity(human),
              operation,
            );
            return op.status === "succeeded" && op;
          });
          const items = await wait(async () => {
            const r = await req(`/v1/bindings/${binding}/messages`, human);
            return (
              r.body.items.length === 3 &&
              r.body.items.every((m: any) =>
                ["matched", "unmatched"].includes(m.match_status),
              ) &&
              r.body.items
            );
          });
          assert.equal(
            items.filter((m: any) => m.match_status === "matched").length,
            2,
          );
          assert.equal(imports, 0);
          assert.equal(charges, 0);
          const filtered = await req(
            `/v1/bindings/${binding}/messages?operation=${operation}&limit=1`,
            human,
          );
          assert.equal(filtered.body.items.length, 1);
          assert.ok(filtered.body.next_cursor);
          const next = await req(
            `/v1/bindings/${binding}/messages?operation=${operation}&limit=1&cursor=${filtered.body.next_cursor}`,
            human,
          );
          assert.notEqual(next.body.items[0].id, filtered.body.items[0].id);
          assert.equal(
            (
              await req(
                `/v1/bindings/${binding}/messages?cursor=${filtered.body.next_cursor}`,
                human,
              )
            ).status,
            400,
          );
          assert.equal(
            (await req(`/v1/bindings/${binding}/messages`, other)).status,
            404,
          );
          const detail = await req(
            `/v1/bindings/${binding}/messages/${items[0].id}`,
            human,
          );
          assert.equal(detail.body.attachments[0].filename, "resume.pdf");
        },
      );
      await t.test(
        "only human confirmation delivers selected content; replay does not duplicate import",
        async () => {
          const items = (await req(`/v1/bindings/${binding}/messages`, human))
            .body.items;
          const draft = await req(
            `/v1/bindings/${binding}/selections`,
            agent,
            "POST",
            { message_id: items[0].id, attachment_indexes: [0] },
            "pick",
          );
          assert.equal(draft.status, 201);
          selection = draft.body.id;
          assert.equal(draft.body.status, "draft");
          assert.equal(
            (await req(`/v1/selections/${selection}/confirm`, agent, "POST"))
              .status,
            403,
          );
          assert.equal(imports, 0);
          loseImportAck = true;
          assert.equal(
            (await req(`/v1/selections/${selection}/confirm`, human, "POST"))
              .status,
            202,
          );
          await wait(async () => {
            const s = (await req(`/v1/selections/${selection}`, human)).body;
            return s.status === "delivered" && s;
          });
          assert.equal(imports, 1);
          assert.equal(
            (await req(`/v1/selections/${selection}/confirm`, human, "POST"))
              .body.status,
            "delivered",
          );
          assert.equal(imports, 1);
        },
      );
      await t.test(
        "AI runs on the matching queue and uses one credit receipt despite lost acknowledgements",
        async () => {
          const b = await req(
            "/v1/bindings",
            human,
            "POST",
            {
              mailbox_id: mailbox,
              project_id: "p2",
              folders: ["INBOX"],
              matching: { mode: "ai", ai_prompt: "Find resume applications" },
            },
            "ai-bind",
          );
          assert.equal(b.status, 201);
          loseMatchAck = true;
          const task = await req(
            `/v1/bindings/${b.body.id}/imports`,
            human,
            "POST",
            range,
            "ai-import",
          );
          await wait(async () => {
            const r = await req(`/v1/bindings/${b.body.id}/messages`, human);
            return (
              r.body.items.length === 3 &&
              r.body.items.every((m: any) =>
                ["matched", "unmatched"].includes(m.match_status),
              )
            );
          });
          assert.equal(charges, 3);
          const again = await req(
            `/v1/bindings/${b.body.id}/imports`,
            human,
            "POST",
            range,
            "same-range-new-task",
          );
          await wait(
            async () =>
              (await req(`/v1/operations/${again.body.id}`, human)).body
                .status === "succeeded",
          );
          assert.equal(charges, 3);
          assert.equal(imports, 1);
        },
      );
      await t.test(
        "transaction rollback removes both the operation and its pg-boss job",
        async () => {
          const before = Number(
            (await db.pool.query("SELECT count(*) FROM mail_operations"))
              .rows[0].count,
          );
          await assert.rejects(
            db.tx(async (c) => {
              await service.operation(
                c,
                await service.identity(human),
                mailbox,
                binding,
                "import",
                {},
              );
              throw new Error("fault before commit");
            }),
          );
          assert.equal(
            Number(
              (await db.pool.query("SELECT count(*) FROM mail_operations"))
                .rows[0].count,
            ),
            before,
          );
          const orphan = (
            await db.pool.query(
              "SELECT count(*) FROM mail_jobs.job j WHERE j.name='mail-operation' AND NOT EXISTS(SELECT 1 FROM mail_operations o WHERE o.id=j.data->>'id')",
            )
          ).rows[0].count;
          assert.equal(Number(orphan), 0);
        },
      );
      await t.test(
        "failed range resumes from its committed page without duplicates; cancel is terminal and retryable",
        async () => {
          scanFailure = true;
          const task = await req(
            `/v1/bindings/${binding}/imports`,
            human,
            "POST",
            range,
            "failing-import",
          );
          const failed = await wait(async () => {
            const op = (await req(`/v1/operations/${task.body.id}`, human))
              .body;
            return op.status === "failed" && op;
          });
          assert.equal(failed.cursor, "2");
          assert.equal(failed.indexed, 2);
          scanFailure = false;
          assert.equal(
            (await req(`/v1/operations/${task.body.id}/retry`, human, "POST"))
              .status,
            202,
          );
          const complete = await wait(async () => {
            const op = (await req(`/v1/operations/${task.body.id}`, human))
              .body;
            return op.status === "succeeded" && op;
          });
          assert.equal(complete.indexed, 3);
          const cancelled = await req(
            `/v1/bindings/${binding}/imports`,
            human,
            "POST",
            range,
            "cancel-import",
          );
          assert.equal(
            (
              await req(
                `/v1/operations/${cancelled.body.id}/cancel`,
                human,
                "POST",
              )
            ).body.status,
            "cancelled",
          );
          await new Promise((r) => setTimeout(r, 1100));
          assert.equal(
            (await req(`/v1/operations/${cancelled.body.id}`, human)).body
              .status,
            "cancelled",
          );
        },
      );
      await t.test(
        "continuous background discovery is permission-aware and does not bill flags changes twice",
        async () => {
          const ai = (await req("/v1/bindings", human)).body.items.find(
            (b: any) => b.project_id === "p2",
          );
          const before = charges;
          const now = new Date().toISOString();
          mail.push(
            message(
              "new-live",
              "新的简历",
              new Date(Date.now() - 10000).toISOString(),
            ),
          );
          assert.equal(
            (
              await req(`/v1/bindings/${ai.id}`, human, "PATCH", {
                version: ai.version,
                continuous: true,
              })
            ).status,
            200,
          );
          const worker = new MailWorker(service, gateway);
          await worker.tick();
          await wait(async () => {
            const rows = (await req(`/v1/bindings/${ai.id}/messages`, human))
              .body.items;
            return rows.some(
              (m: any) =>
                m.summary.ref === "new-live" && m.match_status === "matched",
            );
          });
          assert.equal(charges, before + 1);
          mail.at(-1)!.flags.seen = true;
          await worker.tick();
          await wait(
            async () =>
              Number(
                (
                  await db.pool.query(
                    "SELECT count(*) FROM mail_operations WHERE binding_id=$1 AND status IN ('running','queued','retrying')",
                    [ai.id],
                  )
                ).rows[0].count,
              ) === 0,
          );
          assert.equal(charges, before + 1);
          const current = (await req(`/v1/bindings/${ai.id}`, human)).body;
          await req(`/v1/bindings/${ai.id}`, human, "PATCH", {
            version: current.version,
            continuous: false,
          });
          mail.pop();
        },
      );
      await t.test(
        "version conflicts, revoked project access, owner disabled and no writable role",
        async () => {
          assert.equal(
            (
              await req(`/v1/bindings/${binding}`, human, "PATCH", {
                version: 999,
                continuous: true,
              })
            ).status,
            409,
          );
          const updated = await req("/admin/principals", admin, "PUT", {
            tenant: "t1",
            user: "u1",
            version: 1,
            projects: { p1: "read" },
          });
          assert.equal(updated.status, 200);
          assert.equal(
            (
              await req(
                `/v1/bindings/${binding}/imports`,
                human,
                "POST",
                range,
                "denied",
              )
            ).status,
            403,
          );
          assert.equal(
            (await req(`/v1/bindings/${binding}/messages`, human)).status,
            200,
          );
          await service.setPrincipal({
            tenant: "t1",
            user: "u1",
            version: 2,
            projects: {},
          });
          assert.equal(
            (await req(`/v1/bindings/${binding}/messages`, human)).status,
            403,
          );
          assert.equal(
            (await req(`/v1/operations/${operation}`, human)).status,
            403,
          );
          await service.setPrincipal({
            tenant: "t1",
            user: "u1",
            version: 3,
            enabled: false,
            projects: { p1: "write" },
          });
          assert.equal((await req("/v1/mailboxes", human)).status, 401);
          await service.setPrincipal({
            tenant: "t1",
            user: "u1",
            version: 4,
            projects: { p1: "write", p2: "write" },
          });
        },
      );
      await t.test(
        "OAuth authorization is scoped, PKCE-protected, single-use, and checks mailbox identity",
        async () => {
          const sessions = new ConnectionSessions(service, {
            publicUrl: "https://mail.example.test",
            google: {
              clientId: "synthetic-client",
              clientSecret: "synthetic-secret",
            },
          });
          const p = await service.identity(human);
          const session = await sessions.begin(p, {
            provider: "gmail",
            expected_email: "oauth@example.test",
          });
          const url = new URL(session.url);
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          assert.equal(
            url.searchParams.get("redirect_uri"),
            "https://mail.example.test/v1/oauth/callback",
          );
          assert.ok(!session.url.includes("synthetic-secret"));
          const previous = globalThis.fetch;
          globalThis.fetch = async (input: any) =>
            new Response(
              JSON.stringify(
                String(input).includes("/token")
                  ? {
                      access_token: "test-access",
                      refresh_token: "test-refresh",
                    }
                  : { emailAddress: "wrong@example.test" },
              ),
              { status: 200 },
            );
          try {
            await assert.rejects(
              sessions.complete(url.searchParams.get("state")!, "test-code"),
              /does not match/,
            );
            await assert.rejects(
              sessions.complete(url.searchParams.get("state")!, "test-code"),
              /already used/,
            );
            const next = await sessions.begin(p, {
              provider: "gmail",
              expected_email: "oauth@example.test",
            });
            globalThis.fetch = async (input: any) =>
              new Response(
                JSON.stringify(
                  String(input).includes("/token")
                    ? {
                        access_token: "test-access",
                        refresh_token: "test-refresh",
                      }
                    : { emailAddress: "oauth@example.test" },
                ),
                { status: 200 },
              );
            const connected: any = await sessions.complete(
              new URL(next.url).searchParams.get("state")!,
              "test-code",
            );
            assert.ok(connected.mailbox_id);
          } finally {
            globalThis.fetch = previous;
          }
        },
      );
      await t.test(
        "lost or expired queue jobs become visible failed operations",
        async () => {
          await db.boss.offWork(QUEUES.operation);
          const task = await service.db.tx((c) =>
            service.operation(
              c,
              {
                tenant: "t1",
                user: "u1",
                enabled: true,
                projects: { p1: "write" },
              },
              mailbox,
              binding,
              "import",
              {},
            ),
          );
          const op = await service.getOperation(
            await service.identity(human),
            task.id,
          );
          await db.boss.deleteJob(QUEUES.operation, op.job_id);
          await new MailWorker(service, gateway).tick();
          assert.equal(
            (await service.getOperation(await service.identity(human), task.id))
              .status,
            "failed",
          );
        },
      );
      await t.test(
        "actual MCP discovery, read parity, draft-only selection and denied direct calls",
        async () => {
          const server = serve({
            fetch: app.fetch,
            hostname: "127.0.0.1",
            port: 0,
          });
          await new Promise<void>((r) => server.once("listening", r));
          const port = (server.address() as any).port;
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["dist/mail/mcp.js"],
            env: {
              ...process.env,
              MAIL_URL: `http://127.0.0.1:${port}`,
              MAIL_DELEGATED_TOKEN: agent,
            } as Record<string, string>,
            stderr: "pipe",
          });
          const client = new Client({ name: "mail-test", version: "1" });
          try {
            await client.connect(transport);
            const list = await client.listTools();
            assert.ok(list.tools.some((t) => t.name === "start_mail_import"));
            assert.ok(!list.tools.some((t) => t.name.includes("confirm")));
            const result: any = await client.callTool({
              name: "list_project_mail",
              arguments: { binding_id: binding },
            });
            assert.equal(result.isError, false);
            assert.equal(JSON.parse(result.content[0].text).items.length, 3);
            const denied: any = await client.callTool({
              name: "get_mail_operation",
              arguments: { operation_id: "missing" },
            });
            assert.equal(denied.isError, true);
            await service.revokeToken(agent);
            const revoked: any = await client.callTool({
              name: "list_mailboxes",
              arguments: {},
            });
            assert.equal(revoked.isError, true);
          } finally {
            await client.close();
            await new Promise<void>((r) => server.close(() => r()));
          }
        },
      );
    } finally {
      await db.stop();
      await setup.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await setup.end();
    }
  },
);
