import type { MailDatabase } from "./database.js";
import type { Gateway } from "./gateway.js";

export const WEBHOOK_QUEUE = "mail-webhook-send";
const BATCH_LIMIT = 100;

export class WebhookDelivery {
  constructor(
    public db: MailDatabase,
    public gateway: Gateway,
  ) {}
  async start() {
    await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(58129002)");
      await c.query(`CREATE TABLE IF NOT EXISTS mail_webhook_state(
        id integer PRIMARY KEY CHECK(id=1), last_sequence bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now())`);
      await c.query(
        "INSERT INTO mail_webhook_state(id) VALUES(1) ON CONFLICT DO NOTHING",
      );
    });
    await this.db.boss.createQueue(WEBHOOK_QUEUE, {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 180,
      heartbeatSeconds: 30,
    });
    await this.db.boss.work(WEBHOOK_QUEUE, async () => {
      await this.send();
    });
    await this.db.boss.schedule(WEBHOOK_QUEUE, "* * * * *");
  }
  async send() {
    const events = (
      await this.db.pool.query(
        "SELECT * FROM mail_events WHERE sequence>(SELECT last_sequence FROM mail_webhook_state WHERE id=1) ORDER BY sequence LIMIT $1",
        [BATCH_LIMIT],
      )
    ).rows;
    if (!events.length) return;
    const last = String(events.at(-1).sequence);
    await this.gateway("events", `webhook:${events[0].sequence}`, {
      events: events.map((row: any) => ({
        event_id: row.event_id,
        sequence: Number(row.sequence),
        tenant_id: row.tenant,
        user_id: row.owner_id,
        project_id: row.project_id,
        type: row.type,
        payload: row.payload,
        created_at: row.created_at,
      })),
    });
    // The cursor advances only after the gateway accepted the batch. A crash
    // between the two replays the batch; the receiver dedupes by event_id.
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE mail_webhook_state SET last_sequence=$1::bigint,updated_at=now() WHERE id=1 AND last_sequence<$1::bigint",
        [last],
      );
    });
  }
}
export async function startWebhookDelivery(
  db: MailDatabase,
  gateway: Gateway,
): Promise<WebhookDelivery> {
  const delivery = new WebhookDelivery(db, gateway);
  await delivery.start();
  return delivery;
}
