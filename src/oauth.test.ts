import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthClient } from "./oauth.js";
import { openStore } from "./store.js";
import { makeAdapter } from "./sync.js";
import type { AccountConfig } from "./schema.js";

test("rotated refresh tokens are saved and reused; concurrent refreshes share one request", async t => {
  const used: string[] = [], saved: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    used.push(new URLSearchParams(init.body).get("refresh_token")!);
    return Response.json({ access_token: "access", expires_in: 3600, refresh_token: `rotated-${used.length}` });
  });
  const client = new OAuthClient({ token_url: "https://example.invalid/token", client_id: "test", refresh_token: "original" }, v => { saved.push(v); });
  assert.deepEqual(await Promise.all([client.token(), client.token(), client.token()]), ["access", "access", "access"]);
  assert.equal(used.length, 1);
  await client.token(true);
  assert.deepEqual(used, ["original", "rotated-1"]);
  assert.deepEqual(saved, ["rotated-1", "rotated-2"]);
});

test("missing refresh token preserves the old token and a failed save is retried before a provider request", async t => {
  const used: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    used.push(new URLSearchParams(init.body).get("refresh_token")!);
    return Response.json({ access_token: "access", ...(used.length === 1 ? { refresh_token: "rotated" } : {}) });
  });
  let saves = 0;
  const client = new OAuthClient({ token_url: "https://example.invalid/token", client_id: "test", refresh_token: "original" }, () => {
    if (++saves === 1) throw new Error("synthetic storage failure");
  });
  await assert.rejects(client.token(), /storage failure/);
  assert.equal(used.length, 1);
  await client.token();
  await client.token(true);
  assert.deepEqual(used, ["original", "rotated", "rotated"]);
  assert.equal(saves, 2);
});

test("Gmail and Graph persist rotated credentials encrypted across reopen and reject stale overwrites", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mail-oauth-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url: any) => {
    if (String(url).includes("/token")) return Response.json({ access_token: "access", refresh_token: "rotated-secret" });
    return Response.json({ id: "inbox" });
  });
  for (const provider of ["gmail", "graph"] as const) {
    const cfg: AccountConfig = provider === "gmail"
      ? { provider, address: "test@example.invalid", gmail: { client_id: "test", refresh_token: "old", poll_seconds: 30 } }
      : { provider, address: "test@example.invalid", graph: { client_id: "test", refresh_token: "old", tenant: "common", poll_seconds: 30 } };
    const path = join(dir, `${provider}.db`);
    let store = openStore(path, "encryption-test");
    const id = store.upsertAccount(cfg), previous = structuredClone(cfg);
    const adapter = makeAdapter(cfg, { dataDir: dir, onConfigChanged: () => store.replaceAccountConfig(id, previous, cfg) });
    await adapter.connect();
    const raw = (store.db.prepare("SELECT config FROM accounts WHERE id = ?").get(id) as { config: string }).config;
    assert(raw.startsWith("enc1:")); assert(!raw.includes("rotated-secret"));
    await adapter.close(); store.close();
    store = openStore(path, "encryption-test");
    try {
      const actual = store.accounts()[0]!.config as any;
      assert.equal(actual[provider].refresh_token, "rotated-secret");
      assert.throws(() => store.replaceAccountConfig(id, previous, previous), /configuration changed/);
    } finally { store.close(); }
  }
});
