const PROXY_SCHEMES = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
]);

export function parseImapProxy(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MAIL_IMAP_PROXY must be a valid proxy URL");
  }
  if (!PROXY_SCHEMES.has(url.protocol))
    throw new Error(
      "MAIL_IMAP_PROXY must use http, https, socks, socks4, socks4a or socks5",
    );
  if (!url.hostname || !url.port)
    throw new Error("MAIL_IMAP_PROXY must include a host and port");
  return raw;
}
