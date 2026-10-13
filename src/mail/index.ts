import { serve } from "@hono/node-server";
import { MailDatabase } from "./database.js";
import { MailService } from "./service.js";
import { providerFactory } from "./provider.js";
import { MailWorker } from "./worker.js";
import { mailApi } from "./api.js";
import { ConnectionSessions } from "./oauth.js";
import { httpGateway } from "./gateway.js";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const database = required("DATABASE_URL"),
  secret = required("MAIL_SECRET"),
  admin = required("MAIL_ADMIN_TOKEN");
if (admin.length < 32)
  throw new Error("MAIL_ADMIN_TOKEN must have at least 32 characters");
const allowPrivate = process.env.MAIL_ALLOW_PRIVATE_HOSTS === "true";
if (allowPrivate && process.env.NODE_ENV === "production")
  throw new Error("Private host overrides are disabled in production");
const base = process.env.MAIL_HOST_GATEWAY_URL;
const db = new MailDatabase(database, secret);
await db.start();
const service = new MailService(db, providerFactory(allowPrivate), {
  allowPrivate,
  aiEnabled: !!base,
  deliveryEnabled: !!base,
});
const gateway = base
  ? httpGateway(base, required("MAIL_HOST_GATEWAY_SECRET"))
  : async () => {
      throw new Error("Host gateway is not configured");
    };
const worker = new MailWorker(service, gateway);
const role = process.env.MAIL_ROLE ?? "all";
if (!["api", "worker", "all"].includes(role))
  throw new Error("MAIL_ROLE must be api, worker, or all");
let server: ReturnType<typeof serve> | undefined;
if (role !== "worker") {
  const publicUrl = process.env.MAIL_PUBLIC_URL ?? "http://localhost:8095";
  const sessions = new ConnectionSessions(service, {
    publicUrl,
    ...(process.env.MAIL_GOOGLE_CLIENT_ID
      ? {
          google: {
            clientId: required("MAIL_GOOGLE_CLIENT_ID"),
            clientSecret: required("MAIL_GOOGLE_CLIENT_SECRET"),
          },
        }
      : {}),
    ...(process.env.MAIL_MICROSOFT_CLIENT_ID
      ? {
          microsoft: {
            clientId: required("MAIL_MICROSOFT_CLIENT_ID"),
            clientSecret: required("MAIL_MICROSOFT_CLIENT_SECRET"),
            tenant: process.env.MAIL_MICROSOFT_TENANT ?? "common",
          },
        }
      : {}),
  });
  server = serve({
    fetch: mailApi(service, admin, sessions).fetch,
    hostname: process.env.MAIL_BIND_HOST ?? "127.0.0.1",
    port: Number(process.env.MAIL_PORT ?? 8095),
  });
}
if (role !== "api") await worker.start();
console.log(JSON.stringify({ service: "mail-intake", role, status: "ready" }));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server?.close();
  await db.stop();
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
