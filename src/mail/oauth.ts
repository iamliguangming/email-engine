import { microsoftEndpoints, requiresMicrosoftConsent, type MicrosoftCloud } from "./microsoft-cloud.js";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { MailService, hash } from "./service.js";
import { fail, type Identity } from "./contracts.js";
export interface OAuthApps {
  publicUrl: string;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenant: string; cloud?: MicrosoftCloud };
}
export class ConnectionSessions {
  constructor(
    public service: MailService,
    public apps: OAuthApps,
  ) {}
  async begin(p: Identity, input: unknown) {
    const data = z
      .object({
        provider: z.enum(["gmail", "graph"]),
        expected_email: z.email(),
      })
      .strict()
      .parse(input);
    if (
      data.provider === "gmail" &&
      (this.service.options.gmailAuthMode ?? "imap") !== "oauth"
    )
      fail(
        "gmail_oauth_disabled",
        "Gmail OAuth is disabled; use the IMAP app-password flow",
        403,
      );
    const app =
      data.provider === "gmail" ? this.apps.google : this.apps.microsoft;
    if (!app)
      fail(
        "oauth_not_configured",
        "Operator must configure the provider OAuth app",
        503,
      );
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expires = new Date(Date.now() + 600000).toISOString();
    await this.service.db.pool.query(
      "INSERT INTO mail_connection_sessions(state_hash,tenant,owner_id,provider,expected_email,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        hash(state),
        p.tenant,
        p.user,
        data.provider,
        data.expected_email.toLowerCase(),
        this.service.db.cipher.encrypt(verifier),
        expires,
      ],
    );
    const redirect = `${this.apps.publicUrl.replace(/\/$/, "")}/v1/oauth/callback`;
    const scope =
      data.provider === "gmail"
        ? "https://www.googleapis.com/auth/gmail.readonly"
        : `openid ${microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).scope} ${microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).graph}/User.Read`;
    const url = new URL(
      data.provider === "gmail"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).authorize,
    );
    for (const [k, v] of Object.entries({
      client_id: app!.clientId,
      redirect_uri: redirect,
      response_type: "code",
      state,
      scope,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      login_hint: data.expected_email,
    }))
      url.searchParams.set(k, v);
    if (data.provider === "gmail") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
    }
    return { url: url.toString(), expires_at: expires };
  }
  async complete(state: string, code: string) {
    const session = (
      await this.service.db.pool.query(
        "UPDATE mail_connection_sessions SET used_at=now() WHERE state_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING *",
        [hash(state)],
      )
    ).rows[0];
    if (!session)
      fail(
        "oauth_session_expired",
        "Connection session expired or already used",
        410,
      );
    const principal = await this.service.db.tx((c) =>
      this.service.principal(c, session.tenant, session.owner_id),
    );
    const app =
      session.provider === "gmail" ? this.apps.google : this.apps.microsoft;
    if (!app) fail("oauth_not_configured", "OAuth app is unavailable", 503);
    const endpoint =
      session.provider === "gmail"
        ? "https://oauth2.googleapis.com/token"
        : microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).token;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: app!.clientId,
      client_secret: app!.clientSecret,
      code,
      redirect_uri: `${this.apps.publicUrl.replace(/\/$/, "")}/v1/oauth/callback`,
      code_verifier: this.service.db.cipher.decrypt(session.verifier),
    });
    const response = await fetch(endpoint, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const tokens: any = await response.json();
    if (session.provider === "graph" && requiresMicrosoftConsent(tokens.error, tokens.error_description))
      fail("oauth_admin_required", "Microsoft consent requires administrator review; stop and contact the administrator", 403);
    if (!response.ok || !tokens.refresh_token || !tokens.access_token)
      fail(
        "oauth_exchange_failed",
        "Authorization did not return offline access; start a new connection",
        400,
      );
    const profile = await fetch(
      session.provider === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : `${microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).graph}/v1.0/me?$select=mail,userPrincipalName`,
      {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    const account: any = await profile.json();
    const email = (
      account.emailAddress ??
      account.mail ??
      account.userPrincipalName ??
      ""
    ).toLowerCase();
    if (!profile.ok || email !== session.expected_email)
      fail(
        "oauth_mailbox_mismatch",
        "Authorized mailbox does not match the requested address",
        403,
      );
    const config =
      session.provider === "gmail"
        ? {
            provider: "gmail",
            address: email,
            gmail: {
              client_id: app!.clientId,
              client_secret: app!.clientSecret,
              refresh_token: tokens.refresh_token,
            },
          }
        : {
            provider: "graph",
            address: email,
            graph: {
              tenant: this.apps.microsoft!.tenant,
              client_id: app!.clientId,
              client_secret: app!.clientSecret,
              refresh_token: tokens.refresh_token,
              scope: microsoftEndpoints(this.apps.microsoft!.cloud, this.apps.microsoft!.tenant).scope,
              ...(this.apps.microsoft!.cloud === "china" ? { base_url: microsoftEndpoints("china", this.apps.microsoft!.tenant).graph, token_url: microsoftEndpoints("china", this.apps.microsoft!.tenant).token } : {}),
            },
          };
    const existing = (
      await this.service.db.pool.query(
        "SELECT * FROM mail_accounts WHERE tenant=$1 AND owner_id=$2 AND address=$3",
        [principal.tenant, principal.user, email],
      )
    ).rows[0];
    if (existing) {
      const parsed = (await import("../schema.js")).AccountConfig.parse(config);
      return this.service.db.tx(async (c) => {
        await this.service.principal(c, principal.tenant, principal.user);
        await c.query(
          "UPDATE mail_accounts SET config=$2,status='pending',error=null,version=version+1 WHERE id=$1",
          [existing.id, this.service.db.cipher.encrypt(JSON.stringify(parsed))],
        );
        return this.service.operation(
          c,
          principal,
          existing.id,
          null,
          "verify",
          {},
        );
      });
    }
    return this.service.createAccount(
      { ...principal, actor: "human" },
      config,
      session.state_hash,
      true,
    );
  }
}
