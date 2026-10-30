/** Offline Microsoft OAuth and read-only Graph checks; no real tenant is contacted. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectionSessions } from "./oauth.js";
import { mailApi } from "./api.js";
import { hash, type MailService } from "./service.js";
import { validateConfig } from "./provider.js";
import { microsoftEndpoints } from "./microsoft-cloud.js";
import { GraphAdapter } from "../graph.js";
import { simpleParser } from "mailparser";

const ADDRESS = "mail-test@example.test";
const CONTENT = "测试自动收取总结邮件";
const DESTINATION = "http://localhost:5173/mail";
const TOKEN_URL = "https://login.microsoftonline.com/mock-tenant/oauth2/v2.0/token";
const PROFILE_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
const identity = { tenant: "test-org", user: "test-user", enabled: true, projects: {}, actor: "human" as const, version: 1 };
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fixture(t: TestContext, options: { tokenStatus?: number; profileEmail?: string; cloud?: "global" | "china" } = {}) {
  const oldFetch = globalThis.fetch;
  const oldReturn = process.env.MAIL_OAUTH_RETURN_URL;
  process.env.MAIL_OAUTH_RETURN_URL = DESTINATION;
  const endpoints = microsoftEndpoints(options.cloud, "mock-tenant");
  const tokenUrl = endpoints.token;
  const profileUrl = endpoints.graph + "/v1.0/me?$select=mail,userPrincipalName";
  const calls: string[] = [];
  const created: any[] = [];
  const states = new Map<string, any>();
  // Fail closed: no request falls through to a real network implementation.
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === tokenUrl) return options.tokenStatus
      ? json({ error: "invalid_grant", error_description: "synthetic failure" }, options.tokenStatus)
      : json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
    if (url === profileUrl) return json({ mail: options.profileEmail ?? ADDRESS });
    throw new Error("Offline test blocked an unexpected network request");
  };
  const query = async (sql: string, values: any[] = []) => {
    if (sql.startsWith("INSERT INTO mail_connection_sessions")) {
      const [state_hash, tenant, owner_id, provider, expected_email, verifier, expires_at] = values;
      states.set(state_hash, { state_hash, tenant, owner_id, provider, expected_email, verifier, expires_at, used: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE mail_connection_sessions SET used_at")) {
      const row = states.get(values[0]);
      if (!row || row.used || Date.parse(row.expires_at) <= Date.now()) return { rows: [], rowCount: 0 };
      row.used = true;
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM mail_accounts")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected SQL in in-memory test");
  };
  const service = {
    identity: async () => identity,
    principal: async () => identity,
    db: { pool: { query }, tx: async (fn: (c: object) => Promise<unknown>) => fn({ query }),
      cipher: { encrypt: (s: string) => "fake:" + s, decrypt: (s: string) => s.slice(5) } },
    createAccount: async (...args: any[]) => { created.push(args); return { mailbox_id: "mock-mailbox", operation_id: "mock-verify", status: "queued" }; },
  } as unknown as MailService;
  const sessions = new ConnectionSessions(service, { publicUrl: "http://localhost:8095", microsoft: { clientId: "fake-client", clientSecret: "fake-secret", tenant: "mock-tenant", cloud: options.cloud } });
  const app = mailApi(service, "fake-admin", sessions);
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldReturn === undefined) delete process.env.MAIL_OAUTH_RETURN_URL;
    else process.env.MAIL_OAUTH_RETURN_URL = oldReturn;
  });
  return { app, sessions, calls, created, states, async begin() {
    const response = await app.request("/v1/connection-sessions", { method: "POST", headers: { authorization: "Bearer mock-user", "content-type": "application/json" }, body: JSON.stringify({ provider: "graph", expected_email: ADDRESS }) });
    assert.equal(response.status, 201);
    const result: any = await response.json();
    return new URL(result.url);
  } };
}

test("legacy Microsoft configuration keeps global endpoints", async (t) => {
  const f = fixture(t), url = await f.begin();
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.notEqual(url.origin, "https://login.chinacloudapi.cn");
  assert.match(url.searchParams.get("scope")!, /https:\/\/graph.microsoft.com\/Mail.Read/);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8095/v1/oauth/callback");
  assert.equal(f.calls.length, 0); // Generating a URL never opens it.
});

test("successful consent connects an existing mailbox and returns safe status", async (t) => {
  const f = fixture(t), url = await f.begin();
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=connected");
  assert.deepEqual(f.calls, [TOKEN_URL, PROFILE_URL]);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0][1].provider, "graph");
  assert.equal(f.created[0][1].graph.scope, "https://graph.microsoft.com/Mail.Read offline_access");
  assert.doesNotMatch(response.headers.get("location")!, /fake-code|fake-access|fake-refresh|fake-secret/);
});

test("consent or admin approval failure stops without token exchange or account creation", async (t) => {
  const f = fixture(t), url = await f.begin();
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&error=consent_required&error_description=synthetic-admin-required");
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=oauth_admin_required");
  assert.equal(f.calls.length, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.states.get(hash(url.searchParams.get("state")!)).used, true);
});

test("token refusal is attempted once and does not retry or read messages", async (t) => {
  const f = fixture(t, { tokenStatus: 400 }), url = await f.begin();
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=oauth_failed");
  assert.deepEqual(f.calls, [TOKEN_URL]);
  assert.equal(f.created.length, 0);
});

test("wrong mailbox is refused before account creation", async (t) => {
  const f = fixture(t, { profileEmail: "different@example.test" }), url = await f.begin();
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=oauth_mailbox_mismatch");
  assert.equal(f.calls.length, 2);
  assert.equal(f.created.length, 0);
});

test("expired state stops without network calls", async (t) => {
  const f = fixture(t), url = await f.begin();
  f.states.get(hash(url.searchParams.get("state")!)).expires_at = "2000-01-01T00:00:00Z";
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=oauth_session_expired");
  assert.equal(f.calls.length, 0);
  assert.equal(f.created.length, 0);
});

test("China endpoints are accepted only as a matching official pair", async () => {
  const endpoints = microsoftEndpoints("china", "mock-tenant");
  const config = { provider: "graph", address: ADDRESS, graph: { tenant: "mock-tenant", client_id: "fake-client", refresh_token: "fake-refresh", scope: endpoints.scope, base_url: endpoints.graph, token_url: endpoints.token } };
  await validateConfig(config);
  for (const overrides of [ { token_url: "https://evil.example.test/token" }, { base_url: "http://127.0.0.1" }, { token_url: microsoftEndpoints("global", "mock-tenant").token }, { token_url: "https://login.chinacloudapi.cn/other/oauth2/v2.0/token" } ]) {
    await assert.rejects(validateConfig({ ...config, graph: { ...config.graph, ...overrides } }), (error: any) => error.code === "invalid_endpoint");
  }
});

test("China consent uses China login, profile, persisted refresh endpoint and readonly scope", async (t) => {
  const f = fixture(t, { cloud: "china" }), url = await f.begin();
  const endpoints = microsoftEndpoints("china", "mock-tenant");
  assert.equal(url.origin, "https://login.chinacloudapi.cn");
  assert.equal(url.searchParams.get("scope"), "openid " + endpoints.scope + " " + endpoints.graph + "/User.Read");
  assert.doesNotMatch(url.searchParams.get("scope")!, /Mail.ReadWrite|Mail.Send/);
  const response = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(response.headers.get("location"), DESTINATION + "?mail_oauth=connected");
  assert.deepEqual(f.calls, [endpoints.token, endpoints.graph + "/v1.0/me?$select=mail,userPrincipalName"]);
  const config = f.created[0][1];
  assert.equal(config.graph.base_url, endpoints.graph);
  assert.equal(config.graph.token_url, endpoints.token);
  assert.equal(config.graph.scope, endpoints.scope);
  await validateConfig(config);
  const replay = await f.app.request("/v1/oauth/callback?state=" + url.searchParams.get("state") + "&code=fake-code");
  assert.equal(replay.headers.get("location"), DESTINATION + "?mail_oauth=oauth_session_expired");
  assert.equal(f.created.length, 1);
});

test("China Graph reads one synthetic MIME message, preserves content and rotates refresh tokens", async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const endpoints = microsoftEndpoints("china", "mock-tenant");
  const config = { provider: "graph" as const, address: ADDRESS, graph: { tenant: "mock-tenant", client_id: "fake-client", refresh_token: "fake-old", scope: endpoints.scope, base_url: endpoints.graph, token_url: endpoints.token, poll_seconds: 30 } };
  const calls: Array<{ url: string; method: string }> = [];
  let saved = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === endpoints.token) {
      assert.equal(new URLSearchParams(String(init?.body)).get("scope"), endpoints.scope);
      return json({ access_token: "fake-access", refresh_token: "fake-rotated", expires_in: 3600 });
    }
    if (url === endpoints.graph + "/v1.0/me/messages/mock-message-1/$value" && method === "GET") return new Response("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Buffer.from(CONTENT).toString("base64"));
    throw new Error("Offline test blocked unexpected mail access");
  };
  const adapter = new GraphAdapter(config, async () => { saved = config.graph.refresh_token; });
  const source = await adapter.source("INBOX", "mock-message-1");
  const body = await simpleParser(source!);
  assert.equal(body.text?.trim(), CONTENT);
  assert.equal(saved, "fake-rotated");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => !/sendMail|mailFolders|delta/.test(c.url)));
  await adapter.close();
});

test("offline message fixture uses only the approved text and synthetic identifiers", () => {
  const message = { id: "mock-message-1", subject: CONTENT, body: { contentType: "text", content: CONTENT } };
  assert.equal(message.subject, "测试自动收取总结邮件");
  assert.equal(message.body.content, message.subject);
  assert.equal(ADDRESS.endsWith("@example.test"), true);
});


test("China range import requests only selected folders and validates continuation before use", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const endpoints = microsoftEndpoints("china", "mock-tenant");
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === endpoints.token) return json({ access_token: "fake-access", expires_in: 3600 });
    const parsed = new URL(url);
    assert.equal(parsed.origin, endpoints.graph);
    assert.ok(["/v1.0/me/mailFolders/folder-one/messages", "/v1.0/me/mailFolders/folder-two/messages"].includes(parsed.pathname));
    return json({ value: [{ id: "mock-message-1", subject: CONTENT, receivedDateTime: "2026-01-03T00:00:00Z" }] });
  };
  const config = { provider: "graph" as const, address: ADDRESS, graph: { tenant: "mock-tenant", client_id: "fake-client", refresh_token: "fake-refresh", scope: endpoints.scope, base_url: endpoints.graph, token_url: endpoints.token, poll_seconds: 30 } };
  const adapter = new GraphAdapter(config);
  const range = { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", folders: ["folder-one", "folder-two"] };
  const first = await adapter.scanRange(range, null);
  assert.deepEqual(first.messages[0]!.folderPaths, ["folder-one"]);
  const second = await adapter.scanRange(range, first.next);
  assert.deepEqual(second.messages[0]!.folderPaths, ["folder-two"]);
  assert.equal(second.next, null);
  const before = calls.length;
  for (const cursor of ["https://evil.example.test/v1.0/me/mailFolders/folder-one/messages", endpoints.graph + "/v1.0/me/messages", endpoints.graph + "/v1.0/me/mailFolders/not-selected/messages"])
    await assert.rejects(adapter.scanRange(range, cursor), /invalid Graph pagination/);
  assert.equal(calls.length, before);
  await adapter.close();
});
