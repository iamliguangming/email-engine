import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailAdapter } from "../gmail.js";
import { GraphAdapter } from "../graph.js";
import { ImapAdapter } from "../imap.js";
import { AccountConfig } from "../schema.js";
import { validateConfig } from "./provider.js";
const range = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-02-01T00:00:00.000Z",
  folders: ["INBOX"],
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
test("Gmail range uses receipt-time epoch queries, page tokens, folder filters and MIME attachments", async () => {
  const previous = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/token"))
      return json({ access_token: "synthetic", expires_in: 3600 });
    if (url.includes("/messages?"))
      return json({
        messages: [{ id: "a" }, { id: "b" }, { id: "c" }],
        nextPageToken: "next",
      });
    const id = url.split("/messages/")[1]!.split("?")[0];
    return json({
      id,
      internalDate: String(
        Date.parse(id === "c" ? range.to : "2026-01-03T00:00:00.000Z"),
      ),
      labelIds: id === "b" ? ["SENT"] : ["INBOX"],
      payload: {
        headers: [{ name: "Subject", value: "CV" }],
        parts: [{ filename: "cv.pdf" }],
      },
    });
  };
  try {
    const cfg = AccountConfig.parse({
      provider: "gmail",
      address: "x@example.test",
      gmail: { client_id: "test", refresh_token: "test" },
    });
    assert.equal(cfg.provider, "gmail");
    const adapter = new GmailAdapter(cfg as any);
    const page = await adapter.scanRange(range, "page-2");
    assert.deepEqual(
      page.messages.map((m) => m.ref),
      ["a"],
    );
    assert.equal(page.messages[0]!.hasAttachments, true);
    assert.equal(page.next, "next");
    const query = new URL(requests.find((r) => r.includes("/messages?"))!)
      .searchParams;
    assert.equal(query.get("pageToken"), "page-2");
    assert.match(query.get("q")!, /after:1767225599/);
    assert.ok(
      requests
        .filter((r) => r.includes("/messages/"))
        .every((r) => r.includes("format=full")),
    );
  } finally {
    globalThis.fetch = previous;
  }
});
test("Graph range uses receivedDateTime, honors folders, and rejects foreign pagination URLs", async () => {
  const previous = globalThis.fetch;
  let seen = "";
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes("/token"))
      return json({ access_token: "synthetic", expires_in: 3600 });
    seen = url;
    return json({
      value: [
        {
          id: "a",
          parentFolderId: "INBOX",
          receivedDateTime: "2026-01-04T00:00:00Z",
          sentDateTime: "2020-01-01T00:00:00Z",
          hasAttachments: true,
        },
        {
          id: "b",
          parentFolderId: "OTHER",
          receivedDateTime: "2026-01-04T00:00:00Z",
        },
      ],
    });
  };
  try {
    const cfg = AccountConfig.parse({
      provider: "graph",
      address: "x@example.test",
      graph: {
        client_id: "test",
        refresh_token: "test",
        scope: "https://graph.microsoft.com/Mail.Read offline_access",
      },
    });
    const adapter = new GraphAdapter(cfg as any);
    const page = await adapter.scanRange(range, null);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]!.date, "2026-01-04T00:00:00.000Z");
    assert.match(
      new URL(seen).searchParams.get("$filter")!,
      /receivedDateTime ge/,
    );
    await assert.rejects(
      adapter.scanRange(range, "https://attacker.invalid/v1.0/me/messages"),
      /pagination/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});
test("IMAP range respects UTC internal date, excludes end boundary and detects UIDVALIDITY changes", async () => {
  const adapter = new ImapAdapter(
    AccountConfig.parse({
      provider: "imap",
      address: "x@example.test",
      imap: { host: "imap.example.test", user: "x", pass: "x" },
    }) as any,
  );
  let released = 0,
    query: any;
  const fake = {
    mailbox: { uidValidity: 7, uidNext: 4 },
    getMailboxLock: async () => ({
      release() {
        released++;
      },
    }),
    search: async () => [1, 2, 3],
    async *fetch(ids: any, q: any) {
      query = q;
      for (const uid of ids)
        yield {
          uid,
          internalDate: new Date(
            uid === 3 ? range.to : "2026-01-02T00:00:00.000Z",
          ),
          envelope: { date: new Date("2020-01-01T00:00:00Z") },
          flags: new Set(),
        };
    },
    fetchOne: async () => ({ source: Buffer.from("message") }),
  };
  (adapter as any).client = async () => fake;
  const page = await adapter.scanRange(range, null);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0]!.ref, "7:1");
  assert.equal(query.internalDate, true);
  assert.equal(released, 1);
  await assert.rejects(
    adapter.scanRange(
      range,
      JSON.stringify({ folder: 0, last: 1, validity: "6" }),
    ),
    /uidvalidity/,
  );
  assert.equal(released, 2);
  (adapter as any).withFolder = async (_path: string, fn: any) => fn(fake);
  await assert.rejects(adapter.source("INBOX", "6:1"), /uidvalidity/);
  assert.equal((await adapter.source("INBOX", "7:1"))!.toString(), "message");
});
test("mailbox configuration forbids arbitrary token endpoints, insecure TLS and unsupported transports", async () => {
  await assert.rejects(
    validateConfig({
      provider: "gmail",
      address: "x@example.test",
      gmail: {
        client_id: "x",
        refresh_token: "x",
        token_url: "http://127.0.0.1/token",
      },
    }),
    /Custom Gmail/,
  );
  await assert.rejects(
    validateConfig({
      provider: "imap",
      address: "x@example.test",
      imap: { host: "localhost", user: "x", pass: "x", secure: false },
    }),
    /TLS/,
  );
  await assert.rejects(
    validateConfig({
      provider: "inbound",
      address: "x@example.test",
      inbound: { port: 25 },
    }),
    /IMAP/,
  );
});
