import { z } from "zod";
export const ID = z.string().min(1).max(200);
export const Principal = z.object({
  tenant: ID,
  user: ID,
  enabled: z.boolean().default(true),
  projects: z.record(z.string(), z.enum(["read", "write"])),
  version: z.number().int().positive().optional(),
});
export type Principal = z.infer<typeof Principal>;
export type Identity = Principal & { actor: "human" | "agent" };
export const Rule = z
  .object({
    field: z.enum([
      "subject",
      "sender",
      "recipient",
      "snippet",
      "has_attachment",
    ]),
    operator: z.enum(["contains", "equals"]),
    value: z.string().min(1).max(500),
  })
  .strict();
export const Matching = z
  .object({
    mode: z.enum(["manual", "rules", "ai"]).default("manual"),
    rules: z.array(Rule).max(30).default([]),
    rule_logic: z.enum(["all", "any"]).default("all"),
    ai_prompt: z.string().max(4000).default(""),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "rules" && !v.rules.length)
      c.addIssue({
        code: "custom",
        message: "rules mode needs at least one rule",
      });
    if (v.mode === "ai" && !v.ai_prompt.trim())
      c.addIssue({
        code: "custom",
        message: "AI matching needs a project description",
      });
    for (const r of v.rules)
      if (
        r.field === "has_attachment" &&
        (r.operator !== "equals" || !["true", "false"].includes(r.value))
      )
        c.addIssue({
          code: "custom",
          message: "has_attachment requires equals true or false",
        });
  });
export const BindingCreate = z
  .object({
    mailbox_id: ID,
    project_id: ID,
    folders: z.array(ID).min(1).max(100),
    matching: Matching,
    continuous: z.boolean().default(false),
  })
  .strict();
export const BindingUpdate = z
  .object({
    version: z.number().int().positive(),
    matching: Matching.optional(),
    continuous: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const ImportRange = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), "from must precede to")
  .transform((v) => ({
    from: new Date(v.from).toISOString(),
    to: new Date(v.to).toISOString(),
  }));
export const Pick = z
  .object({
    message_id: ID,
    attachment_indexes: z.array(z.number().int().min(0)).max(30).default([]),
    include_body: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.attachment_indexes.length > 0 || v.include_body,
    "select at least one attachment or the message body",
  );
export const MatchResult = z.object({
  matched: z.boolean(),
  reason: z.string().max(2000),
  charge_id: z.string().min(1),
  credits: z.number().nonnegative(),
});
export class MailError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new MailError(code, message, status);
};
export const requireProject = (
  p: Principal,
  project: string,
  write = false,
) => {
  const role = p.projects[project];
  if (!p.enabled || !role || (write && role !== "write"))
    fail("project_access_denied", "Project permission required", 403);
};
export function matchRules(
  config: z.infer<typeof Matching>,
  message: any,
): { matched: boolean; reason: string } {
  const result = config.rules.map((r) => {
    const values: Record<string, string> = {
      subject: message.subject ?? "",
      sender: message.from?.address ?? "",
      recipient: (message.to ?? []).map((a: any) => a.address).join(","),
      snippet: message.snippet ?? "",
      has_attachment: String(message.hasAttachments ?? false),
    };
    const actual = values[r.field]!.normalize("NFKC").toLocaleLowerCase();
    const expected = r.value.normalize("NFKC").toLocaleLowerCase();
    return r.operator === "equals"
      ? actual === expected
      : actual.includes(expected);
  });
  return {
    matched:
      config.rule_logic === "all"
        ? result.every(Boolean)
        : result.some(Boolean),
    reason: `${result.filter(Boolean).length}/${result.length} rules matched`,
  };
}
