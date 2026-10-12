import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, type MessageRow } from "./store.js";
import { Engine } from "./sync.js";
import { createApi } from "./api.js";
import { hashSecret } from "./scope.js";

function fixture() {
  const store = openStore(":memory:", "test-only-secret");
  const engine = new Engine(store, { dataDir: "/unused" });
  const app = createApi(engine, "admin-test");
  const accounts = ["a", "b", "c"].map(name => store.upsertAccount({
    provider: "imap", address: `${name}@example.invalid`, imap: { host: "unused.invalid", port: 993, secure: true, user: name, pass: "test", insecure_tls: false },
  }));
  const [a, b, c] = accounts as [string, string, string];
  function add(id: string, account: string, role: string, date: string) {
    const folder = store.upsertFolder(account, role, role, role);
    const m: MessageRow = { id, account, thread_id: id, header_message_id: id, in_reply_to: null, refs: [], subject: "candidate",
      from: null, to: [], cc: [], date, flags: { seen: false, flagged: false, answered: false, draft: false }, trust: "unverified", size: 1, snippet: "candidate", has_attachments: false, fingerprint: id };
    store.insertMessage(m); store.linkFolder(id, folder.id, id); store.setTags(id, ["candidate"], [], "test");
  }
  add("visible", a, "inbox", "2026-01-01");
  add("hidden-folder", a, "archive", "2026-01-02");
  add("hidden-account", c, "inbox", "2026-01-03");
  store.insertToken("scoped", hashSecret("scoped"), { name: "test", accounts: [a, b], folders: ["inbox"], events: [], actions: [], redact: [], mode: "propose_only", publish: false, expires_at: null });
  const request = (path: string, token = "scoped", body?: unknown) => app.request(path, {
    method: body ? "POST" : "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { store, request, a, b, c };
}

test("health reveals no mailbox metadata without authentication and scopes authenticated results", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await (await f.request("/health", "")).json(), { ok: true });
    const body = await (await f.request("/health")).json();
    assert.deepEqual(body.accounts.map((a: any) => a.id).sort(), [f.a, f.b].sort());
    assert.equal((await (await f.request("/health", "admin-test")).json()).accounts.length, 3);
  } finally { f.store.close(); }
});

test("search applies account and folder scopes before limiting, for text, tags and combined queries", async () => {
  const f = fixture();
  try {
    for (const query of ["tag=candidate", "q=candidate", "q=candidate&tag=candidate"]) {
      const r = await f.request(`/search?${query}&limit=1`);
      assert.equal(r.status, 200);
      assert.deepEqual((await r.json()).results.map((m: any) => m.id), ["visible"]);
    }
    assert.equal((await (await f.request("/search?tag=candidate", "admin-test")).json()).results.length, 3);
    for (const limit of ["-1", "0", "201", "Infinity", "NaN", "1.5"]) {
      assert.equal((await f.request(`/search?tag=candidate&limit=${limit}`)).status, 400);
    }
  } finally { f.store.close(); }
});

test("tag counts exclude both unauthorized accounts and folders", async () => {
  const f = fixture();
  try {
    assert.deepEqual((await (await f.request("/tags")).json()).tags, [{ tag: "candidate", count: 1 }]);
    assert.deepEqual((await (await f.request("/tags", "admin-test")).json()).tags, [{ tag: "candidate", count: 3 }]);
    assert.equal((await f.request("/messages/hidden-account")).status, 404);
    assert.equal((await f.request("/messages/hidden-folder")).status, 404);
  } finally { f.store.close(); }
});

test("replaying another account's client key cannot expose its action", async () => {
  const f = fixture();
  try {
    const body = { client_key: "shared-key", type: "create_draft", params: { account: f.c, to: [], subject: "synthetic private draft", text: "synthetic" } };
    const original = await (await f.request("/actions?mode=propose", "admin-test", body)).json();
    const denied = await f.request("/actions", "scoped", { ...body, params: { ...body.params, account: f.a } });
    assert.equal(denied.status, 403);
    assert.equal((await (await f.request("/actions?mode=propose", "admin-test", body)).json()).id, original.id);
    f.store.deleteToken("scoped");
    assert.equal((await f.request("/tags")).status, 401);
  } finally { f.store.close(); }
});
