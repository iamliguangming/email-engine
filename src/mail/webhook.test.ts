import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { MailDatabase } from "./database.js";
import { WebhookDelivery, WEBHOOK_QUEUE, startWebhookDelivery } from "./webhook.js";
import type { Gateway } from "./gateway.js";
const dbUrl = process.env.MAIL_TEST_DATABASE_URL;
const secret = "test-only-mail-secret-32-characters-long";
const skip =
  !dbUrl && "Set MAIL_TEST_DATABASE_URL to an isolated PostgreSQL instance";
const open = async (t: any) => {
  const setup = new pg.Pool({ connectionString: dbUrl });
  const name = `mail_test_webhook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await setup.query(`CREATE DATABASE ${name}`);
  const u = new URL(dbUrl!);
  u.pathname = `/${name}`;
  const db = new MailDatabase(u.toString(), secret);
  await db.start();
  t.after(async () => {
    await db.stop();
    await setup.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await setup.end();
  });
  return db;
};
const seed = (db: MailDatabase, count: number, offset = 0) =>
  db.tx(async (c) => {
    for (let i = 1; i <= count; i++)
      await c.query(
        "INSERT INTO mail_events(sequence,event_id,tenant,owner_id,project_id,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          offset + i,
          `event-${offset + i}`,
          "org:1",
          "user:2",
          "project:3",
          "selection.confirmed",
          { index: offset + i },
        ],
      );
    await c.query("UPDATE mail_event_sequence SET value=$1 WHERE id=1", [
      offset + count,
    ]);
  });
const cursor = async (db: MailDatabase) =>
  String(
    (
      await db.pool.query(
        "SELECT last_sequence FROM mail_webhook_state WHERE id=1",
      )
    ).rows[0]?.last_sequence,
  );
const recorder = () => {
  const calls: Array<{ kind: string; key: string; payload: any }> = [];
  const gateway: Gateway = async (kind, key, payload) => {
    calls.push({ kind, key, payload });
    return { received: (payload as any).events?.length ?? 0 };
  };
  return { calls, gateway };
};
test(
  "webhook delivers pending events in order and advances the cursor once accepted",
  { skip },
  async (t) => {
    const db = await open(t);
    const { calls, gateway } = recorder();
    const delivery = new WebhookDelivery(db, gateway);
    await delivery.start();
    await seed(db, 3);
    await delivery.send();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, "events");
    assert.equal(calls[0]!.key, "webhook:1");
    const sent = calls[0]!.payload.events;
    assert.deepEqual(
      sent.map((e: any) => e.sequence),
      [1, 2, 3],
    );
    assert.equal(sent[0].event_id, "event-1");
    assert.equal(sent[0].tenant_id, "org:1");
    assert.equal(sent[0].user_id, "user:2");
    assert.equal(sent[0].project_id, "project:3");
    assert.equal(sent[0].type, "selection.confirmed");
    assert.deepEqual(sent[0].payload, { index: 1 });
    await delivery.send();
    assert.equal(calls.length, 1);
    assert.equal(await cursor(db), "3");
  },
);
test(
  "a rejected batch keeps the cursor so the same events replay after recovery",
  { skip },
  async (t) => {
    const db = await open(t);
    const { calls, gateway } = recorder();
    let failing = true;
    const flaky: Gateway = async (kind, key, payload) => {
      if (failing) throw new Error("gateway_down");
      return gateway(kind, key, payload);
    };
    const delivery = new WebhookDelivery(db, flaky);
    await delivery.start();
    await seed(db, 2);
    await assert.rejects(delivery.send(), /gateway_down/);
    assert.equal(await cursor(db), "0");
    failing = false;
    await delivery.send();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.key, "webhook:1");
    assert.equal(await cursor(db), "2");
  },
);
test(
  "delivery drains large backlogs in bounded batches",
  { skip },
  async (t) => {
    const db = await open(t);
    const { calls, gateway } = recorder();
    const delivery = new WebhookDelivery(db, gateway);
    await delivery.start();
    await seed(db, 150);
    await delivery.send();
    await delivery.send();
    assert.deepEqual(
      calls.map((c) => [c.key, c.payload.events.length]),
      [
        ["webhook:1", 100],
        ["webhook:101", 50],
      ],
    );
    await delivery.send();
    assert.equal(calls.length, 2);
    assert.equal(await cursor(db), "150");
  },
);
test(
  "startWebhookDelivery registers the queue and its per-minute schedule",
  { skip },
  async (t) => {
    const db = await open(t);
    const { gateway } = recorder();
    const delivery = await startWebhookDelivery(db, gateway);
    assert.ok(delivery instanceof WebhookDelivery);
    assert.equal(
      (
        await db.pool.query("SELECT name FROM mail_jobs.queue WHERE name=$1", [
          WEBHOOK_QUEUE,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await db.pool.query("SELECT cron FROM mail_jobs.schedule WHERE name=$1", [
          WEBHOOK_QUEUE,
        ])
      ).rows[0].cron,
      "* * * * *",
    );
  },
);
