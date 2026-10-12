// Fork regression: exercise the real MCP process against the shared HTTP authorization layer.
// Synthetic mail only; no provider connections. Run npm run build first.
import assert from "node:assert/strict";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openStore } from "../dist/store.js";
import { Engine } from "../dist/sync.js";
import { createApi } from "../dist/api.js";
import { hashSecret } from "../dist/scope.js";

const store = openStore(":memory:", "synthetic-test-secret");
const app = createApi(new Engine(store, { dataDir: "/unused" }), "test-admin");
const accounts = ["a", "b", "c"].map(name => store.upsertAccount({ provider: "imap", address: `${name}@example.invalid`,
  imap: { host: "unused.invalid", port: 993, secure: true, user: name, pass: "test", insecure_tls: false } }));
for (const [id, account, role, date] of [
  ["visible", accounts[0], "inbox", "2026-01-01"],
  ["hidden-folder", accounts[0], "archive", "2026-01-02"],
  ["hidden-account", accounts[2], "inbox", "2026-01-03"],
]) {
  const folder = store.upsertFolder(account, role, role, role);
  store.insertMessage({ id, account, thread_id: id, header_message_id: id, in_reply_to: null, refs: [], subject: "candidate",
    from: null, to: [], cc: [], date, flags: { seen: false, flagged: false, answered: false, draft: false },
    trust: "unverified", size: 1, snippet: "candidate", has_attachments: false, fingerprint: id });
  store.linkFolder(id, folder.id, id);
  store.setTags(id, ["candidate"], [], "test");
}
store.insertToken("scoped", hashSecret("test-scoped"), { name: "mcp-test", accounts: accounts.slice(0, 2), folders: ["inbox"],
  events: [], actions: ["search", "get_message", "set_flags", "propose", "get_action"], redact: [], mode: "propose_only", publish: false, expires_at: null });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
const client = new Client({ name: "isolation-test", version: "1.0.0" });
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const decode = r => { assert(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
try {
  if (!server.listening) await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/mcp.js"],
    env: { ...process.env, ENGINE_URL: base, ENGINE_MCP_TOKEN: "test-scoped" } }));
  await check("tool discovery", async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ["search_mail", "get_message", "list_tags", "set_flags"]) assert(names.includes(name));
  });
  await check("scoped search before limit matches HTTP", async () => {
    const result = decode(await client.callTool({ name: "search_mail", arguments: { query: "candidate", tag: "candidate", limit: 1 } }));
    const http = await (await fetch(`${base}/search?q=candidate&tag=candidate&limit=1`, { headers: { authorization: "Bearer test-scoped" } })).json();
    assert.deepEqual(result.map(m => m.id), ["visible"]);
    assert.deepEqual(result.map(m => m.id), http.results.map(m => m.id));
  });
  await check("tag aggregation obeys account and folder scopes", async () => {
    assert.deepEqual(decode(await client.callTool({ name: "list_tags", arguments: {} })).tags, [{ tag: "candidate", count: 1 }]);
  });
  await check("direct reads cannot bypass scope", async () => {
    for (const message_id of ["hidden-account", "hidden-folder"]) {
      assert((await client.callTool({ name: "get_message", arguments: { message_id, include_body: false } })).isError);
    }
    assert.equal(decode(await client.callTool({ name: "get_message", arguments: { message_id: "visible", include_body: false } })).id, "visible");
  });
  await check("writes remain proposals and the agent cannot approve", async () => {
    const proposal = decode(await client.callTool({ name: "set_flags", arguments: { message_id: "visible", flagged: true } }));
    assert.equal(proposal.status, "proposed");
    assert((await client.callTool({ name: "approve_action", arguments: { action_id: proposal.id } })).isError);
    assert.equal(store.actionById(proposal.id).status, "proposed");
  });
  await check("revocation takes effect in the existing MCP session", async () => {
    store.deleteToken("scoped");
    const result = await client.callTool({ name: "search_mail", arguments: { query: "candidate" } });
    assert(result.isError); assert.match(result.content[0].text, /401/);
  });
  console.log(`${passed}/6 MCP checks passed`);
} finally {
  await client.close();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  store.close();
}
