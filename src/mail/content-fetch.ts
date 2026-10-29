import { MailError } from "./contracts.js";
import { errorFields, logEvent } from "./log.js";
import type { MailContent, MailProvider } from "./provider.js";

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
  "ETHROTTLE",
]);
const RETRYABLE_NAMES = new Set([
  "NoResponse",
  "ConnectionClosed",
  "TimeoutError",
  "ESOCKET",
]);

export function isRetryableProviderError(error: any): boolean {
  if (error?.authenticationFailed) return false;
  if (error instanceof MailError) return error.retryable;
  if (RETRYABLE_CODES.has(String(error?.code ?? ""))) return true;
  return RETRYABLE_NAMES.has(String(error?.name ?? ""));
}

export async function fetchProviderContent(
  open: () => Promise<MailProvider>,
  summary: any,
): Promise<MailContent> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let provider: MailProvider | undefined;
    try {
      provider = await open();
      return await provider.content(summary);
    } catch (error) {
      if (attempt > 0 || !isRetryableProviderError(error)) throw error;
      logEvent("warn", "content_fetch_retry", {
        attempt: attempt + 1,
        elapsed_ms: Date.now() - started,
        ...errorFields(error),
      });
      await new Promise(resolve => setTimeout(resolve, 150));
    } finally {
      if (provider) await provider.close().catch(() => {});
    }
  }
  throw new Error("content fetch retry loop exhausted");
}
