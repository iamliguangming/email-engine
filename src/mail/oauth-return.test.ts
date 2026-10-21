import assert from "node:assert/strict";
import test from "node:test";
import { oauthReturnUrl, completeOAuthReturn } from "./oauth-return.js";
import { MailError } from "./contracts.js";
import type { ConnectionSessions } from "./oauth.js";
import { mailApi } from "./api.js";
import type { MailService } from "./service.js";

const target = "http://localhost:5173/mail";
function session(complete: () => Promise<unknown>, rowCount = 1) {
  return { complete, service: { db: { pool: { query: async () => ({ rowCount }) } } },
    apps: { google: { clientId: "fake", clientSecret: "never-return-this" } } } as unknown as ConnectionSessions;
}

test("return destination is operator-controlled and restricts credentials and unsafe schemes", () => {
  assert.equal(oauthReturnUrl(), undefined);
  assert.equal(oauthReturnUrl(target), target);
  assert.equal(oauthReturnUrl("https://recruit.example/mail"), "https://recruit.example/mail");
  for (const url of ["javascript:alert(1)", "http://public.example/mail", "https://user:pass@example.com/mail", target + "?next=x", target + "#x"])
    assert.throws(() => oauthReturnUrl(url));
});

test("successful consent returns status only, never tokens or code", async () => {
  const s = session(async () => ({ mailbox_id: "m1", refresh_token: "private" }));
  const result = await completeOAuthReturn(s, { state: "state", code: "secret-code", return_url: "https://evil.test" }, target);
  assert.equal(result, target + "?mail_oauth=connected");
});

test("cancellation consumes state and expired cancellation cannot be replayed", async () => {
  let called = false;
  const s = session(async () => { called = true; });
  assert.equal(await completeOAuthReturn(s, { state: "s", error: "access_denied" }, target), target + "?mail_oauth=oauth_denied");
  assert.equal(called, false);
  const expired = session(async () => {}, 0);
  assert.match(await completeOAuthReturn(expired, { state: "old", error: "access_denied" }, target), /oauth_session_expired$/);
});

test("mismatch, stale state and network failures return actionable status without exception content", async () => {
  for (const code of ["oauth_mailbox_mismatch", "oauth_session_expired"]) {
    const s = session(async () => { throw new MailError(code, "sensitive", 400); });
    assert.equal(await completeOAuthReturn(s, { state: "s", code: "c" }, target), target + "?mail_oauth=" + code);
  }
  const s = session(async () => { throw new Error("private-provider-response"); });
  assert.equal(await completeOAuthReturn(s, { state: "s", code: "c" }, target), target + "?mail_oauth=oauth_failed");
});

test("real HTTP callback redirects without delegated auth; connection options still require it", async () => {
  const previous = process.env.MAIL_OAUTH_RETURN_URL;
  process.env.MAIL_OAUTH_RETURN_URL = target;
  const service = { identity: async (token: string) => {
    if (token !== "user-token") throw new MailError("unauthorized", "Invalid token", 401);
    return { tenant: "t1", user: "u1", actor: "human" };
  } } as unknown as MailService;
  try {
    const s = session(async () => ({ mailbox_id: "m1" }));
    const app = mailApi(service, "admin", s);
    const response = await app.request("/v1/oauth/callback?state=s&code=c");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), target + "?mail_oauth=connected");
    assert.equal((await app.request("/v1/connection-options")).status, 401);
    const options = await app.request("/v1/connection-options", { headers: { authorization: "Bearer user-token" } });
    assert.deepEqual(await options.json(), { gmail: true, graph: false, microsoft_cloud: "global" });
    const absent = await mailApi(service, "admin").request("/v1/connection-options", { headers: { authorization: "Bearer user-token" } });
    assert.deepEqual(await absent.json(), { gmail: false, graph: false, microsoft_cloud: "global" });
  } finally {
    if (previous === undefined) delete process.env.MAIL_OAUTH_RETURN_URL;
    else process.env.MAIL_OAUTH_RETURN_URL = previous;
  }
});
