import pg, { type PoolClient } from "pg";
import { PgBoss } from "pg-boss";
import { makeCipher } from "../store.js";

const schema = `
CREATE TABLE IF NOT EXISTS mail_principals (
 tenant text NOT NULL, user_id text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 projects jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant,user_id));
CREATE TABLE IF NOT EXISTS mail_tokens (
 hash text PRIMARY KEY, tenant text NOT NULL, user_id text NOT NULL, actor text NOT NULL CHECK(actor IN ('human','agent')),
 expires_at timestamptz NOT NULL, FOREIGN KEY(tenant,user_id) REFERENCES mail_principals);
CREATE TABLE IF NOT EXISTS mail_accounts (
 id text PRIMARY KEY, tenant text NOT NULL, owner_id text NOT NULL, address text NOT NULL, provider text NOT NULL,
 config text NOT NULL, folders jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'pending', error text,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant,owner_id) REFERENCES mail_principals,
 UNIQUE(tenant,owner_id,address));
CREATE TABLE IF NOT EXISTS mail_bindings (
 id text PRIMARY KEY, tenant text NOT NULL, owner_id text NOT NULL, project_id text NOT NULL,
 account_id text NOT NULL REFERENCES mail_accounts, folders jsonb NOT NULL, matching jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true, continuous boolean NOT NULL DEFAULT false, watermark timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1, matching_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,project_id));
CREATE TABLE IF NOT EXISTS mail_operations (
 id text PRIMARY KEY, tenant text NOT NULL, owner_id text NOT NULL, account_id text NOT NULL REFERENCES mail_accounts,
 binding_id text REFERENCES mail_bindings, kind text NOT NULL, status text NOT NULL DEFAULT 'queued', input jsonb NOT NULL,
 cursor text, scanned integer NOT NULL DEFAULT 0, indexed integer NOT NULL DEFAULT 0, error text,
 job_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mail_messages (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES mail_accounts, remote_key text NOT NULL,
 summary jsonb NOT NULL, received_at timestamptz NOT NULL, content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,remote_key));
CREATE INDEX IF NOT EXISTS mail_messages_date ON mail_messages(account_id,received_at,id);
CREATE TABLE IF NOT EXISTS mail_items (
 binding_id text NOT NULL REFERENCES mail_bindings, message_id text NOT NULL REFERENCES mail_messages,
 match_version integer NOT NULL, content_hash text NOT NULL, matching jsonb NOT NULL,
 status text NOT NULL, result jsonb, error text, job_id uuid, PRIMARY KEY(binding_id,message_id));
CREATE TABLE IF NOT EXISTS mail_import_items (
 operation_id text NOT NULL REFERENCES mail_operations, message_id text NOT NULL REFERENCES mail_messages,
 PRIMARY KEY(operation_id,message_id));
CREATE TABLE IF NOT EXISTS mail_selections (
 id text PRIMARY KEY, binding_id text NOT NULL REFERENCES mail_bindings, message_id text NOT NULL REFERENCES mail_messages,
 selection jsonb NOT NULL, evidence jsonb, selected_by text NOT NULL, status text NOT NULL DEFAULT 'draft', result jsonb, error text,
 job_id uuid, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(binding_id,message_id));
ALTER TABLE mail_bindings ADD COLUMN IF NOT EXISTS matching_version integer NOT NULL DEFAULT 1;
ALTER TABLE mail_selections ADD COLUMN IF NOT EXISTS evidence jsonb;
CREATE TABLE IF NOT EXISTS mail_requests (
 tenant text NOT NULL, user_id text NOT NULL, route text NOT NULL, key text NOT NULL, hash text NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(tenant,user_id,route,key));
CREATE TABLE IF NOT EXISTS mail_events (
 sequence bigint PRIMARY KEY, event_id text NOT NULL UNIQUE, tenant text NOT NULL, owner_id text NOT NULL,
 project_id text, type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mail_event_sequence (id integer PRIMARY KEY CHECK(id=1), value bigint NOT NULL);
INSERT INTO mail_event_sequence VALUES(1,0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS mail_connection_sessions (
 state_hash text PRIMARY KEY, tenant text NOT NULL, owner_id text NOT NULL, provider text NOT NULL,
 expected_email text NOT NULL, verifier text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
`;
export type Tx = PoolClient;
export const QUEUES = {
  operation: "mail-operation",
  match: "mail-match",
  delivery: "mail-delivery",
  tick: "mail-tick",
} as const;
export class MailDatabase {
  pool: pg.Pool;
  boss: PgBoss;
  cipher: ReturnType<typeof makeCipher>;
  constructor(
    public url: string,
    secret: string,
  ) {
    if (secret.length < 32)
      throw new Error("MAIL_SECRET must have at least 32 characters");
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 10000,
    });
    this.boss = new PgBoss({
      connectionString: url,
      schema: "mail_jobs",
      monitorIntervalSeconds: 10,
    });
    this.boss.on("error", () =>
      console.error(
        JSON.stringify({ component: "mail_queue", error: "queue_error" }),
      ),
    );
    this.cipher = makeCipher(secret);
  }
  async start() {
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(58129001)");
      await c.query(schema);
    });
    await this.boss.start();
    for (const queue of Object.values(QUEUES))
      await this.boss.createQueue(queue, {
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 180,
        heartbeatSeconds: 30,
      });
  }
  async tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async enqueue(c: Tx, queue: string, data: object) {
    const id = await this.boss.send(queue, data, {
      db: { executeSql: (sql, args) => c.query(sql, args) },
    });
    if (!id) throw new Error("queue_enqueue_failed");
    return id;
  }
  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10000 });
    await this.pool.end();
  }
}
