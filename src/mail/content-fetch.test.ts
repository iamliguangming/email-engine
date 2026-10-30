import assert from "node:assert/strict";
import test from "node:test";
import { MailError } from "./contracts.js";
import { fetchProviderContent } from "./content-fetch.js";

function provider(onContent: () => Promise<any>) {
  return {
    async verify() {
      return [];
    },
    async scan() {
      return { messages: [], next: null };
    },
    content: onContent,
    async close() {},
  } as any;
}

test("content fetch retries once on a transient provider failure", async () => {
  let calls = 0;
  const body = await fetchProviderContent(
    async () =>
      provider(async () => {
        calls++;
        if (calls === 1) {
          const error: any = new Error("reset");
          error.code = "ECONNRESET";
          throw error;
        }
        return { text: "ok", attachments: [] };
      }),
    {},
  );
  assert.equal(body.text, "ok");
  assert.equal(calls, 2);
});

test("content fetch retries IMAP connection timeouts", async () => {
  let calls = 0;
  const body = await fetchProviderContent(
    async () =>
      provider(async () => {
        calls++;
        if (calls === 1) {
          const error: any = new Error("connection timeout");
          error.code = "CONNECT_TIMEOUT";
          throw error;
        }
        return { text: "ok", attachments: [] };
      }),
    {},
  );
  assert.equal(body.text, "ok");
  assert.equal(calls, 2);
});

test("content fetch does not retry authentication failures", async () => {
  let calls = 0;
  await assert.rejects(
    fetchProviderContent(
      async () =>
        provider(async () => {
          calls++;
          const error: any = new Error("login failed");
          error.authenticationFailed = true;
          throw error;
        }),
      {},
    ),
    /login failed/,
  );
  assert.equal(calls, 1);
});

test("content fetch does not retry non-retryable MailErrors", async () => {
  let calls = 0;
  await assert.rejects(
    fetchProviderContent(
      async () =>
        provider(async () => {
          calls++;
          throw new MailError("message_too_large", "too large", 413);
        }),
      {},
    ),
    /too large/,
  );
  assert.equal(calls, 1);
});
