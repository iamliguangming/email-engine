import assert from "node:assert/strict";
import test from "node:test";
import { MailService } from "./service.js";
import {
  isGmailImapConfig,
  parseGmailAuthMode,
} from "./gmail-mode.js";

const identity = {
  tenant: "t1",
  user: "u1",
  projects: {},
  enabled: true,
  actor: "human" as const,
  version: 1,
};

function imapConfig(address: string, host = "localhost") {
  return {
    provider: "imap" as const,
    address,
    imap: {
      host,
      port: 993,
      secure: true,
      insecure_tls: false,
      user: address,
      pass: "app-password",
    },
  };
}

test("Gmail auth mode defaults to imap and rejects unknown values", () => {
  assert.equal(parseGmailAuthMode(undefined), "imap");
  assert.equal(parseGmailAuthMode("imap"), "imap");
  assert.equal(parseGmailAuthMode("oauth"), "oauth");
  assert.throws(() => parseGmailAuthMode("smtp"), /imap or oauth/);
});

test("isGmailImapConfig recognizes Gmail addresses and Gmail IMAP hosts only", () => {
  assert.equal(isGmailImapConfig(imapConfig("user@gmail.com")), true);
  assert.equal(isGmailImapConfig(imapConfig("user@googlemail.com")), true);
  assert.equal(isGmailImapConfig(imapConfig("user@example.com", "imap.gmail.com")), true);
  assert.equal(isGmailImapConfig(imapConfig("user@example.com", "imap.googlemail.com")), true);
  assert.equal(isGmailImapConfig(imapConfig("user@example.com")), false);
  assert.equal(isGmailImapConfig({ ...imapConfig("user@gmail.com"), provider: "gmail" } as any), false);
});

test("oauth mode rejects new Gmail IMAP accounts before any write", async () => {
  const service = new MailService({} as any, {} as any, {
    aiEnabled: false,
    deliveryEnabled: false,
    allowPrivate: true,
    gmailAuthMode: "oauth",
  });
  await assert.rejects(
    service.createAccount(identity, imapConfig("user@gmail.com"), "key"),
    (error: any) => error.code === "gmail_imap_disabled",
  );
});

test("oauth mode does not block non-Gmail IMAP accounts at validation", () => {
  const config = imapConfig("user@example.com");
  assert.equal(isGmailImapConfig(config), false);
});
