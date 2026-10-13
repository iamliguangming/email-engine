import { readLimited } from "./mail/limits.js";
// Fork modification (2026-10-12): coalesce refresh requests and persist rotated refresh tokens.
// OAuth 2.0 refresh-token client shared by the Gmail and Graph adapters.
// Holds one refresh token, caches the access token, retries a 401 once.
export interface OAuthConfig {
  token_url: string;
  client_id: string;
  client_secret?: string | undefined;
  refresh_token: string;
  scope?: string | undefined;
}

export class OAuthClient {
  private access: { token: string; expires: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private rotationPending = false;

  constructor(private cfg: OAuthConfig, private onRefreshToken?: (token: string) => void | Promise<void>) {}

  async token(force = false): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh(force).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async saveRotation() {
    if (!this.rotationPending) return;
    await this.onRefreshToken?.(this.cfg.refresh_token);
    this.rotationPending = false;
  }

  private async refresh(force: boolean): Promise<string> {
    // Retry a failed persistence before using the credential or contacting the provider again.
    await this.saveRotation();
    if (!force && this.access && this.access.expires > Date.now() + 60_000) return this.access.token;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfg.refresh_token,
      client_id: this.cfg.client_id,
      ...(this.cfg.client_secret ? { client_secret: this.cfg.client_secret } : {}),
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    });
    const r = await fetch(this.cfg.token_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30000), body });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const e: any = new Error(`token refresh failed: ${r.status} ${j.error ?? ""} ${j.error_description ?? ""}`.trim());
      e.authenticationFailed = r.status === 400 || r.status === 401; // invalid_grant: the refresh token is dead
      throw e;
    }
    if (typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== this.cfg.refresh_token) {
      this.cfg.refresh_token = j.refresh_token;
      this.rotationPending = true;
      await this.saveRotation();
    }
    this.access = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  /** Authenticated fetch. Refreshes and retries once on 401. Throws with authenticationFailed when auth is gone. */
  async fetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.token();
    const r = await fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30000), headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (r.status === 401 && retry) {
      await this.token(true);
      return this.fetch(url, init, false);
    }
    if (r.status === 401) {
      const e: any = new Error("unauthorized after token refresh");
      e.authenticationFailed = true;
      throw e;
    }
    return r;
  }

  /** JSON helper: throws on non-2xx with the provider's error text. 404 is returned as null when `allow404`. */
  async json<T = any>(url: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const r = await this.fetch(url, init);
    if (r.status === 404 && allow404) return null;
    if (r.status === 204) return null;
    const text = (await readLimited(r, 24 * 1024 * 1024)).toString("utf8");
    if (!r.ok) {
      const e: any = new Error(`${init.method ?? "GET"} ${url.replace(/\?.*/, "")} -> ${r.status} ${text.slice(0, 200)}`);
      e.status = r.status;
      e.rateLimited = r.status === 429 || (r.status === 403 && /rate|quota/i.test(text));
      throw e;
    }
    return text ? (JSON.parse(text) as T) : null;
  }
}
