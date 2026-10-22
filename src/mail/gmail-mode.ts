import type { AccountConfig } from "../schema.js";

export type GmailAuthMode = "imap" | "oauth";

export function parseGmailAuthMode(value: string | undefined): GmailAuthMode {
  const mode = (value ?? "imap").trim().toLowerCase();
  if (mode !== "imap" && mode !== "oauth")
    throw new Error("MAIL_GMAIL_AUTH_MODE must be imap or oauth");
  return mode;
}

/** True for IMAP configs that represent a Gmail mailbox, including Gmail addresses on a custom host. */
export function isGmailImapConfig(config: AccountConfig): boolean {
  if (config.provider !== "imap") return false;
  const host = config.imap.host.toLowerCase();
  const address = config.address.toLowerCase();
  return (
    host === "imap.gmail.com" ||
    host === "imap.googlemail.com" ||
    address.endsWith("@gmail.com") ||
    address.endsWith("@googlemail.com")
  );
}
