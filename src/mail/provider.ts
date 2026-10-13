import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { simpleParser } from "mailparser";
import { GmailAdapter } from "../gmail.js";
import { GraphAdapter } from "../graph.js";
import { ImapAdapter } from "../imap.js";
import { AccountConfig, type AccountConfig as Config } from "../schema.js";
import type { Adapter, MailRange, RangePage } from "../adapter.js";
import { MailError } from "./contracts.js";

export interface MailProvider {
  verify(): ReturnType<Adapter["listFolders"]>;
  scan(range: MailRange, cursor: string | null): Promise<RangePage>;
  content(summary: any): Promise<{
    text: string;
    attachments: { filename: string; contentType: string; content: Buffer }[];
  }>;
  close(): Promise<void>;
}
export type ProviderFactory = (
  config: Config,
  save: () => Promise<void>,
) => Promise<MailProvider>;
const privateAddress = (ip: string) => {
  if (isIP(ip) === 6) return !/^2[0-9a-f]{3}:/i.test(ip); // public global unicast only; excludes v4-mapped addresses
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
};
export async function validateConfig(
  input: unknown,
  allowPrivate = false,
): Promise<Config> {
  const config = AccountConfig.parse(input);
  if (!["imap", "gmail", "graph"].includes(config.provider))
    throw new MailError(
      "unsupported_provider",
      "Use IMAP, Gmail or Microsoft Graph",
    );
  if (config.provider === "imap") {
    if (!allowPrivate && (!config.imap.secure || config.imap.insecure_tls))
      throw new MailError("tls_required", "Verified TLS is required");
    // No arbitrary OAuth endpoints in credentials submitted by users.
    if (
      config.imap.oauth &&
      ![
        "https://oauth2.googleapis.com/token",
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      ].includes(config.imap.oauth.token_url)
    )
      throw new MailError(
        "invalid_oauth_endpoint",
        "Unsupported OAuth endpoint",
      );
    const addresses = await lookup(config.imap.host, { all: true });
    if (
      !addresses.length ||
      (!allowPrivate && addresses.some((a) => privateAddress(a.address)))
    )
      throw new MailError(
        "invalid_host",
        "Private mail servers require an operator-configured deployment",
      );
    if (config.smtp)
      throw new MailError(
        "read_only_intake",
        "SMTP configuration is not used by this intake service",
      );
  }
  if (
    config.provider === "gmail" &&
    (config.gmail.base_url || config.gmail.token_url) &&
    !allowPrivate
  )
    throw new MailError(
      "invalid_endpoint",
      "Custom Gmail endpoints are disabled",
    );
  if (config.provider === "graph") {
    if (!/^[a-zA-Z0-9.-]+$/.test(config.graph.tenant))
      throw new MailError("invalid_tenant", "Invalid Microsoft tenant");
    if ((config.graph.base_url || config.graph.token_url) && !allowPrivate)
      throw new MailError(
        "invalid_endpoint",
        "Custom Graph endpoints are disabled",
      );
  }
  return config;
}
export function providerFactory(allowPrivate = false): ProviderFactory {
  return async (config, save) => {
    await validateConfig(config, allowPrivate);
    let pinned: string | undefined;
    if (config.provider === "imap") {
      const addresses = await lookup(config.imap.host, { all: true });
      if (
        !addresses.length ||
        (!allowPrivate && addresses.some((a) => privateAddress(a.address)))
      )
        throw new MailError("invalid_host", "Mailbox address is not permitted");
      pinned = addresses[0]!.address;
    }
    const adapter: Adapter =
      config.provider === "gmail"
        ? new GmailAdapter(config, save)
        : config.provider === "graph"
          ? new GraphAdapter(config, save)
          : new ImapAdapter(config as any, save, pinned);
    return {
      async verify() {
        await adapter.connect();
        return adapter.listFolders();
      },
      async scan(range, cursor) {
        await adapter.connect();
        return adapter.scanRange!(range, cursor);
      },
      async content(m) {
        if (m.size > 15 * 1024 * 1024)
          throw new MailError(
            "message_too_large",
            "Message exceeds the 15 MB intake limit",
            413,
          );
        await adapter.connect();
        let ref = m.ref;
        if (config.provider === "imap") {
          const [validity, uid] = String(ref).split(":");
          if (!uid)
            throw new MailError(
              "stale_message",
              "Re-import this message before downloading",
              409,
            );
          // Validate the UID generation at source retrieval, not just at scan time.
          ref = `${validity}:${uid}`;
        }
        const raw = await adapter.source(m.folderPaths[0], ref);
        if (!raw)
          throw new MailError(
            "content_unavailable",
            "Message no longer available at provider",
            410,
          );
        if (raw.length > 15 * 1024 * 1024)
          throw new MailError(
            "message_too_large",
            "Message exceeds the 15 MB intake limit",
            413,
          );
        const body = await simpleParser(raw);
        return {
          text: body.text ?? "",
          attachments: body.attachments.map((a, i) => ({
            filename: a.filename ?? `attachment-${i}`,
            contentType: a.contentType,
            content: a.content,
          })),
        };
      },
      close: () => adapter.close(),
    };
  };
}
