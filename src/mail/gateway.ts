import { createHmac } from "node:crypto";
import { MailError } from "./contracts.js";
export type Gateway = (
  kind: "match" | "import",
  key: string,
  payload: object,
) => Promise<any>;
export function httpGateway(base: string, secret: string): Gateway {
  const url = new URL(base);
  if (!["https:", "http:"].includes(url.protocol) || !secret)
    throw new Error("Invalid host gateway configuration");
  return async (kind, key, payload) => {
    const body = JSON.stringify({ schema_version: 1, ...payload });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${key}.${body}`)
      .digest("hex");
    const response = await fetch(`${base.replace(/\/$/, "")}/${kind}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-mail-timestamp": timestamp,
        "x-mail-signature": signature,
      },
      body,
    });
    if (!response.ok)
      throw new MailError(
        response.status === 402 ? "insufficient_credits" : "gateway_error",
        `Host gateway returned HTTP ${response.status}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    return response.json();
  };
}
