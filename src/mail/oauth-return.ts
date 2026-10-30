import { requiresMicrosoftConsent } from "./microsoft-cloud.js";
import type { ConnectionSessions } from "./oauth.js";
import { hash } from "./service.js";
import { MailError } from "./contracts.js";

// A single operator-controlled destination; never accept a return URL from the browser.
export function oauthReturnUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("MAIL_OAUTH_RETURN_URL must be an HTTPS URL (HTTP localhost allowed), without credentials, query or fragment");
  }
  return url.toString();
}

export async function completeOAuthReturn(
  sessions: ConnectionSessions | undefined,
  query: Record<string, string>,
  destination: string,
): Promise<string> {
  const url = new URL(destination);
  try {
    if (!sessions) throw new MailError("oauth_not_configured", "OAuth unavailable", 503);
    if (!query.state) throw new MailError("invalid_callback", "Missing state", 400);
    if (query.error) {
      // Consume the state on cancellation as well, without accepting a mailbox.
      const cancelled = await sessions.service.db.pool.query(
        "UPDATE mail_connection_sessions SET used_at=now() WHERE state_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING state_hash",
        [hash(query.state)],
      );
      if (!cancelled.rowCount) throw new MailError("oauth_session_expired", "Expired state", 410);
      if (requiresMicrosoftConsent(query.error, query.error_description)) throw new MailError("oauth_admin_required", "Administrator review required", 403);
      throw new MailError("oauth_denied", "Authorization cancelled", 400);
    }
    if (!query.code) throw new MailError("invalid_callback", "Missing code", 400);
    await sessions.complete(query.state, query.code);
    url.searchParams.set("mail_oauth", "connected");
  } catch (error) {
    // Never put provider responses, tokens, email addresses or exception messages in the URL.
    const allowed = ["oauth_denied", "oauth_session_expired", "oauth_mailbox_mismatch", "oauth_not_configured", "oauth_admin_required"];
    const code = error instanceof MailError && allowed.includes(error.code) ? error.code : "oauth_failed";
    url.searchParams.set("mail_oauth", code);
  }
  return url.toString();
}
