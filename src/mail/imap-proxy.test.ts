import assert from "node:assert/strict";
import test from "node:test";
import { parseImapProxy } from "./imap-proxy.js";

test("IMAP proxy accepts HTTP and SOCKS URLs and ignores empty values", () => {
  assert.equal(parseImapProxy(undefined), undefined);
  assert.equal(parseImapProxy("  "), undefined);
  assert.equal(
    parseImapProxy("http://host.docker.internal:7890"),
    "http://host.docker.internal:7890",
  );
  assert.equal(
    parseImapProxy("socks5://127.0.0.1:1080"),
    "socks5://127.0.0.1:1080",
  );
});

test("IMAP proxy rejects unsupported schemes and missing ports", () => {
  assert.throws(() => parseImapProxy("ftp://proxy:21"), /must use/);
  assert.throws(() => parseImapProxy("http://proxy"), /host and port/);
  assert.throws(() => parseImapProxy("not a url"), /valid proxy URL/);
});
