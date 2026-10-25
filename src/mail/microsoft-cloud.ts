/** Only these operator-selected Microsoft clouds may receive OAuth credentials. */
const CLOUDS = {
  global: { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" },
  china: { login: "https://login.chinacloudapi.cn", graph: "https://microsoftgraph.chinacloudapi.cn" },
} as const;
export type MicrosoftCloud = keyof typeof CLOUDS;
export function microsoftCloud(value: string = "global"): MicrosoftCloud {
  if (value !== "global" && value !== "china") throw new Error("MAIL_MICROSOFT_CLOUD must be global or china");
  return value;
}
export function microsoftEndpoints(cloud: string = "global", tenant: string = "common") {
  const name = microsoftCloud(cloud);
  if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new Error("Invalid Microsoft tenant");
  const selected = CLOUDS[name];
  const oauth = `${selected.login}/${tenant}/oauth2/v2.0`;
  return { graph: selected.graph, authorize: `${oauth}/authorize`, token: `${oauth}/token`, scope: `${selected.graph}/Mail.Read offline_access` };
}
export function trustedMicrosoftEndpoints(config: { tenant: string; base_url?: string; token_url?: string }): boolean {
  return Object.keys(CLOUDS).some((cloud) => {
    const urls = microsoftEndpoints(cloud, config.tenant);
    return config.base_url === urls.graph && config.token_url === urls.token;
  });
}
export function requiresMicrosoftConsent(error?: string, description?: string): boolean {
  return error === "admin_consent_required" || error === "consent_required" || /\bAADSTS90094\b/.test(description ?? "");
}
