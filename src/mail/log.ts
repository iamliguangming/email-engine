export type LogLevel = "info" | "warn" | "error";

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: "mail",
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorFields(error: any) {
  return {
    code: error?.code ?? null,
    name: error?.name ?? null,
    message: String(error?.message ?? "").slice(0, 300),
  };
}
