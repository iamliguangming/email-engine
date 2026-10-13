import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { httpGateway } from "./gateway.js";
import { MailError } from "./contracts.js";
import { readLimited } from "./limits.js";
test("host gateway signs exact bytes and keeps the caller idempotency key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    assert.equal(String(input), "https://host.example/mail/match");
    assert.equal(init.redirect, "error");
    const h = init.headers;
    assert.equal(h["idempotency-key"], "stable-key");
    assert.equal(
      h["x-mail-signature"],
      createHmac("sha256", "synthetic-secret")
        .update(`${h["x-mail-timestamp"]}.stable-key.${init.body}`)
        .digest("hex"),
    );
    assert.equal(JSON.parse(init.body).schema_version, 1);
    return new Response(
      JSON.stringify({
        matched: true,
        charge_id: "receipt",
        credits: 1,
        reason: "mock",
      }),
    );
  };
  try {
    const result = await httpGateway(
      "https://host.example/mail",
      "synthetic-secret",
    )("match", "stable-key", { subject: "简历" });
    assert.equal(result.charge_id, "receipt");
  } finally {
    globalThis.fetch = original;
  }
});
test("gateway credit exhaustion is not automatically retried, but overload is", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [402, 429, 503]) {
      globalThis.fetch = async () => new Response("", { status });
      await assert.rejects(
        httpGateway("https://host.example", "s")("match", "k", {}),
        (e: any) => e instanceof MailError && e.retryable === (status !== 402),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("provider body reader enforces actual streamed bytes, not only content-length", async () => {
  assert.equal((await readLimited(new Response("abc"), 3)).toString(), "abc");
  await assert.rejects(readLimited(new Response("abcd"), 3), /too_large/);
  await assert.rejects(
    readLimited(
      new Response("abc", { headers: { "content-length": "999" } }),
      3,
    ),
    /too_large/,
  );
});
