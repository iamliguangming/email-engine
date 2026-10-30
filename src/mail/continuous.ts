export const DEFAULT_CONTINUOUS_INTERVAL_SECONDS = 180;

const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86_400;

export function parseContinuousIntervalSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "")
    return DEFAULT_CONTINUOUS_INTERVAL_SECONDS;
  const seconds = Number(value);
  if (seconds === 0) return 0;
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_INTERVAL_SECONDS ||
    seconds > MAX_INTERVAL_SECONDS
  )
    throw new Error(
      "MAIL_CONTINUOUS_INTERVAL_SECONDS must be 0 or an integer between 30 and 86400",
    );
  return seconds;
}

export function continuousDue(
  lastLiveAt: string | Date | null | undefined,
  now: number,
  intervalSeconds: number,
): boolean {
  if (intervalSeconds <= 0 || !lastLiveAt) return true;
  return now - new Date(lastLiveAt).getTime() >= intervalSeconds * 1000;
}
