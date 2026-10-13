import { openapi } from "./openapi.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MailService, constantEqual } from "./service.js";
import { fail, MailError, type Identity } from "./contracts.js";
import { QUEUES } from "./database.js";
import type { ConnectionSessions } from "./oauth.js";

type Env = { Variables: { identity: Identity; requestId: string } };
export function mailApi(
  service: MailService,
  adminToken: string,
  sessions?: ConnectionSessions,
) {
  const app = new Hono<Env>();
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: { code: "body_too_large", message: "Request exceeds 1 MB" },
          },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    return next();
  });
  app.onError((e, c) => {
    if (e instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: "invalid_arguments",
            message: "Invalid request",
            fields: e.issues.map((i) => ({ path: i.path, message: i.message })),
            request_id: c.get("requestId"),
            retryable: false,
          },
        },
        400,
      );
    if (e instanceof SyntaxError)
      return c.json(
        {
          error: {
            code: "invalid_json",
            message: "Malformed JSON",
            request_id: c.get("requestId"),
            retryable: false,
          },
        },
        400,
      );
    const error =
      e instanceof MailError
        ? e
        : new MailError(
            (e as any).code === "23505" ? "conflict" : "internal_error",
            (e as any).code === "23505"
              ? "Resource already exists"
              : "Request failed",
            (e as any).code === "23505" ? 409 : 500,
          );
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          request_id: c.get("requestId"),
        },
      },
      error.status as any,
    );
  });
  app.get("/openapi.json", (c) => c.json(openapi));
  app.get("/health", async (c) => {
    await service.db.pool.query("SELECT 1");
    return c.json({ ok: true, service: "mail-intake" });
  });
  app.use("/admin/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!constantEqual(token, adminToken))
      fail("unauthorized", "Host service credential required", 401);
    return next();
  });
  app.put("/admin/principals", async (c) =>
    c.json(await service.setPrincipal(await c.req.json())),
  );
  app.post("/admin/delegations", async (c) => {
    const v = z
      .object({
        tenant: z.string().min(1),
        user: z.string().min(1),
        actor: z.enum(["human", "agent"]),
        ttl_seconds: z.number().int().min(30).max(3600).default(300),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.issueToken(v.tenant, v.user, v.actor, v.ttl_seconds),
      201,
    );
  });
  app.delete("/admin/delegations", async (c) => {
    const v = z.object({ token: z.string() }).parse(await c.req.json());
    await service.revokeToken(v.token);
    return c.json({ revoked: true });
  });
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/oauth/callback") return next();
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    c.set("identity", await service.identity(token));
    return next();
  });
  const who = (c: any): Identity => c.get("identity");
  const key = (c: any) => c.req.header("idempotency-key") ?? "";
  app.get("/v1/me", (c) => c.json(who(c)));
  app.post("/v1/connection-sessions", async (c) => {
    if (!sessions) fail("oauth_not_configured", "OAuth is unavailable", 503);
    return c.json(await sessions!.begin(who(c), await c.req.json()), 201);
  });
  app.get("/v1/oauth/callback", async (c) => {
    if (!sessions) fail("oauth_not_configured", "OAuth is unavailable", 503);
    if (c.req.query("error"))
      fail("oauth_denied", "Mailbox authorization was not completed");
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code)
      fail("invalid_callback", "Missing authorization state or code");
    return c.json(await sessions!.complete(state!, code!), 202);
  });
  app.post("/v1/mailboxes", async (c) =>
    c.json(
      await service.createAccount(who(c), await c.req.json(), key(c)),
      202,
    ),
  );
  app.get("/v1/mailboxes", async (c) => {
    const p = who(c);
    return c.json({
      items: (
        await service.db.pool.query(
          "SELECT * FROM mail_accounts WHERE tenant=$1 AND owner_id=$2 ORDER BY created_at",
          [p.tenant, p.user],
        )
      ).rows.map((a) => service.presentAccount(a)),
    });
  });
  app.get("/v1/mailboxes/:id", async (c) =>
    c.json(
      service.presentAccount(await service.account(who(c), c.req.param("id"))),
    ),
  );
  app.patch("/v1/mailboxes/:id/credentials", async (c) =>
    c.json(
      await service.updateCredentials(
        who(c),
        c.req.param("id"),
        await c.req.json(),
      ),
      202,
    ),
  );
  app.post("/v1/mailboxes/:id/reconnect", async (c) => {
    const p = who(c),
      id = c.req.param("id");
    const account = await service.account(p, id);
    if (account.status === "disabled")
      fail("mailbox_disabled", "Reauthorize before reconnecting", 409);
    return c.json(
      await service.request(p, `reconnect:${id}`, key(c), {}, (tx) =>
        service.operation(tx, p, id, null, "verify", {}),
      ),
      202,
    );
  });
  app.post("/v1/bindings", async (c) =>
    c.json(
      await service.createBinding(who(c), await c.req.json(), key(c)),
      201,
    ),
  );
  app.get("/v1/bindings", async (c) => {
    const p = who(c);
    return c.json({
      items: (
        await service.db.pool.query(
          "SELECT * FROM mail_bindings WHERE tenant=$1 AND owner_id=$2 AND project_id=ANY($3::text[]) ORDER BY created_at",
          [p.tenant, p.user, Object.keys(p.projects)],
        )
      ).rows,
    });
  });
  app.get("/v1/bindings/:id", async (c) =>
    c.json(await service.binding(who(c), c.req.param("id"))),
  );
  app.patch("/v1/bindings/:id", async (c) =>
    c.json(
      await service.updateBinding(
        who(c),
        c.req.param("id"),
        await c.req.json(),
      ),
    ),
  );
  app.post("/v1/bindings/:id/rematch", async (c) =>
    c.json(await service.rematch(who(c), c.req.param("id"), key(c)), 202),
  );
  app.delete("/v1/mailboxes/:id", async (c) => {
    const { version } = z
      .object({ version: z.number().int().positive() })
      .parse(await c.req.json());
    return c.json(await service.disconnect(who(c), c.req.param("id"), version));
  });
  app.post("/v1/bindings/:id/imports", async (c) =>
    c.json(
      await service.startImport(
        who(c),
        c.req.param("id"),
        await c.req.json(),
        key(c),
      ),
      202,
    ),
  );
  app.get("/v1/bindings/:id/operations", async (c) => {
    const id = c.req.param("id");
    await service.binding(who(c), id);
    return c.json({
      items: (
        await service.db.pool.query(
          "SELECT * FROM mail_operations WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 100",
          [id],
        )
      ).rows,
    });
  });
  app.get("/v1/bindings/:id/messages", async (c) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(2000).optional(),
        status: z
          .enum([
            "manual",
            "pending",
            "matched",
            "unmatched",
            "retrying",
            "failed",
            "needs_rematch",
          ])
          .optional(),
        operation: z.string().optional(),
      })
      .parse(c.req.query());
    return c.json(await service.listItems(who(c), c.req.param("id"), q));
  });
  app.get("/v1/bindings/:id/messages/:mid", async (c) => {
    const body = await service.getContent(
      who(c),
      c.req.param("id"),
      c.req.param("mid"),
    );
    return c.json({
      text: body.text.slice(0, 200000),
      truncated: body.text.length > 200000,
      attachments: body.attachments.map((a, index) => ({
        index,
        filename: a.filename,
        content_type: a.contentType,
        size: a.content.length,
      })),
    });
  });
  app.get("/v1/bindings/:id/messages/:mid/attachments/:index", async (c) => {
    const index = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(c.req.param("index"));
    const body = await service.getContent(
      who(c),
      c.req.param("id"),
      c.req.param("mid"),
    );
    const a = body.attachments[index];
    if (!a) fail("not_found", "Attachment not found", 404);
    return new Response(new Uint8Array(a!.content), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a!.filename)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  app.get("/v1/operations/:id", async (c) =>
    c.json(await service.getOperation(who(c), c.req.param("id"))),
  );
  for (const action of ["cancel", "retry"] as const)
    app.post(`/v1/operations/:id/${action}`, async (c) =>
      c.json(
        await service.controlOperation(who(c), c.req.param("id"), action),
        202,
      ),
    );
  app.post("/v1/bindings/:id/selections", async (c) =>
    c.json(
      await service.select(
        who(c),
        c.req.param("id"),
        await c.req.json(),
        key(c),
      ),
      201,
    ),
  );
  app.get("/v1/selections/:id", async (c) => {
    const row = (
      await service.db.pool.query("SELECT * FROM mail_selections WHERE id=$1", [
        c.req.param("id"),
      ])
    ).rows[0];
    if (!row) fail("not_found", "Selection not found", 404);
    await service.binding(who(c), row.binding_id);
    return c.json(row);
  });
  app.post("/v1/selections/:id/confirm", async (c) =>
    c.json(await service.confirm(who(c), c.req.param("id")), 202),
  );
  app.post("/v1/selections/:id/retry", async (c) => {
    const p = who(c),
      id = c.req.param("id");
    return c.json(
      await service.db.tx(async (tx) => {
        const s = (
          await tx.query(
            "SELECT * FROM mail_selections WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!s) fail("not_found", "Selection not found", 404);
        await service.binding(p, s.binding_id, true, tx);
        if (s.status !== "failed" || !s.confirmed_at)
          fail(
            "not_retryable",
            "Only a failed confirmed selection can be retried",
            409,
          );
        const job = await service.db.enqueue(tx, QUEUES.delivery, { id });
        return (
          await tx.query(
            "UPDATE mail_selections SET status='queued',error=null,job_id=$2 WHERE id=$1 RETURNING *",
            [id, job],
          )
        ).rows[0];
      }),
      202,
    );
  });
  app.get("/v1/events", async (c) => {
    const p = who(c);
    const after = z
      .string()
      .regex(/^\d{1,19}$/)
      .parse(c.req.query("after") ?? "0");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .parse(c.req.query("limit") ?? 100);
    const rows = (
      await service.db.pool.query(
        "SELECT * FROM mail_events WHERE tenant=$1 AND owner_id=$2 AND (project_id IS NULL OR project_id=ANY($3::text[])) AND sequence>$4::bigint ORDER BY sequence LIMIT $5",
        [p.tenant, p.user, Object.keys(p.projects), after, limit],
      )
    ).rows;
    return c.json({
      events: rows,
      next_cursor: rows.at(-1)?.sequence ?? after,
    });
  });
  return app;
}
