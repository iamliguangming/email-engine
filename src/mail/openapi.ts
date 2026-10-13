import { z } from "zod";
import {
  BindingCreate,
  BindingUpdate,
  ImportRange,
  Pick,
  Principal,
} from "./contracts.js";
import { AccountConfig } from "../schema.js";
const json = (schema: unknown) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paths: Record<string, any> = {};
function route(
  method: string,
  path: string,
  summary: string,
  body?: string,
  status = 200,
  admin = false,
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  if (
    (method === "post" && ["/v1/mailboxes", "/v1/bindings"].includes(path)) ||
    (/\/(imports|selections|reconnect|rematch)$/.test(path) &&
      method === "post")
  )
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string" },
    });
  (paths[path] ??= {})[method] = {
    summary,
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
    security: [{ [admin ? "hostService" : "delegatedUser"]: [] }],
    parameters,
    ...(body
      ? { requestBody: { required: true, content: json(ref(body)) } }
      : {}),
    responses: {
      [status]: {
        description:
          status === 202
            ? "Accepted; inspect background state. This does not mean resume import is complete."
            : "Success",
        content: json({ type: "object" }),
      },
      default: { description: "Structured error", content: json(ref("Error")) },
    },
  };
}
route(
  "put",
  "/admin/principals",
  "Host refreshes authoritative membership and project grants",
  "Principal",
  200,
  true,
);
route(
  "post",
  "/admin/delegations",
  "Host issues a short-lived human or agent delegation",
  "Delegation",
  201,
  true,
);
route(
  "delete",
  "/admin/delegations",
  "Host revokes a delegated token",
  "Revoke",
  200,
  true,
);
route("get", "/v1/me", "Current delegated identity and live project grants");
route(
  "post",
  "/v1/connection-sessions",
  "Create a single-use hosted OAuth authorization URL",
  "Connection",
  201,
);
route("get", "/v1/oauth/callback", "OAuth authorization callback");
paths["/v1/oauth/callback"].get.security = [];
paths["/v1/oauth/callback"].get.parameters = ["state", "code"].map((name) => ({
  name,
  in: "query",
  required: true,
  schema: { type: "string" },
}));
route(
  "post",
  "/v1/mailboxes",
  "Connect an owned IMAP mailbox; Gmail/Graph use OAuth",
  "AccountConfig",
  202,
);
route("get", "/v1/mailboxes", "List owned mailboxes without credentials");
route(
  "get",
  "/v1/mailboxes/{id}",
  "Mailbox state, version and provider folder IDs",
);
route(
  "patch",
  "/v1/mailboxes/{id}/credentials",
  "Replace IMAP credentials and verify",
  "Credentials",
  202,
);
route(
  "post",
  "/v1/mailboxes/{id}/reconnect",
  "Reverify the existing mailbox",
  undefined,
  202,
);
route(
  "delete",
  "/v1/mailboxes/{id}",
  "Disconnect locally and disable bindings; never delete remote mail",
  "Version",
);
route(
  "post",
  "/v1/bindings",
  "Bind an owned mailbox to an authorized project",
  "BindingCreate",
  201,
);
route("get", "/v1/bindings", "List visible project bindings");
route("get", "/v1/bindings/{id}", "Binding configuration and versions");
route(
  "patch",
  "/v1/bindings/{id}",
  "Update matching settings or continuous discovery",
  "BindingUpdate",
);
route(
  "post",
  "/v1/bindings/{id}/imports",
  "Pull a UTC half-open receipt-time interval into the review list",
  "ImportRange",
  202,
);
route(
  "get",
  "/v1/bindings/{id}/operations",
  "Latest 100 operations for this binding",
);
route(
  "post",
  "/v1/bindings/{id}/rematch",
  "Retry failed evaluations or apply a changed matching configuration",
  undefined,
  202,
);
route(
  "get",
  "/v1/bindings/{id}/messages",
  "Paginated review list, including unmatched messages",
);
paths["/v1/bindings/{id}/messages"].get.parameters.push(
  ...["limit", "cursor", "status", "operation"].map((name) => ({
    name,
    in: "query",
    schema: { type: name === "limit" ? "integer" : "string" },
  })),
);
route(
  "get",
  "/v1/bindings/{id}/messages/{mid}",
  "Text preview and attachment metadata",
);
route(
  "get",
  "/v1/bindings/{id}/messages/{mid}/attachments/{index}",
  "Download an attachment without changing read state",
);
paths["/v1/bindings/{id}/messages/{mid}/attachments/{index}"].get.responses[
  "200"
].content = {
  "application/octet-stream": { schema: { type: "string", format: "binary" } },
};
route(
  "get",
  "/v1/operations/{id}",
  "Task state, committed page cursor and counters",
);
for (const action of ["retry", "cancel"])
  route(
    "post",
    `/v1/operations/{id}/${action}`,
    `${action} a background operation`,
    undefined,
    202,
  );
route(
  "post",
  "/v1/bindings/{id}/selections",
  "Create a draft selection; never imports automatically",
  "Pick",
  201,
);
route(
  "get",
  "/v1/selections/{id}",
  "Selection handoff state and downstream import reference",
);
route(
  "post",
  "/v1/selections/{id}/confirm",
  "Human-only confirmation, snapshots content hashes",
  undefined,
  202,
);
route(
  "post",
  "/v1/selections/{id}/retry",
  "Retry an already confirmed failed selection",
  undefined,
  202,
);
route(
  "get",
  "/v1/events",
  "Ordered authorized event replay; opaque decimal-string cursor",
);
paths["/v1/events"].get.parameters = ["after", "limit"].map((name) => ({
  name,
  in: "query",
  schema: { type: name === "limit" ? "integer" : "string" },
}));
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "PinTalent independent mail intake",
    version: "0.2.0",
    description:
      "Independent implementation using Kadri adapters. Matching recommends; human confirmation delivers to the host. See docs/mail-intake.md for provider and delivery semantics.",
  },
  paths,
  components: {
    securitySchemes: {
      delegatedUser: { type: "http", scheme: "bearer" },
      hostService: { type: "http", scheme: "bearer" },
    },
    schemas: {
      ...Object.fromEntries(
        Object.entries({
          BindingCreate,
          BindingUpdate,
          ImportRange,
          Pick,
          Principal,
          AccountConfig,
        }).map(([k, v]) => [
          k,
          z.toJSONSchema(v, { io: "input", unrepresentable: "any" }),
        ]),
      ),
      Version: {
        type: "object",
        required: ["version"],
        properties: { version: { type: "integer", minimum: 1 } },
      },
      Credentials: {
        type: "object",
        required: ["version", "config"],
        properties: {
          version: { type: "integer", minimum: 1 },
          config: ref("AccountConfig"),
        },
      },
      Connection: {
        type: "object",
        required: ["provider", "expected_email"],
        properties: {
          provider: { enum: ["gmail", "graph"] },
          expected_email: { type: "string", format: "email" },
        },
      },
      Revoke: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" } },
      },
      Delegation: {
        type: "object",
        required: ["tenant", "user", "actor"],
        properties: {
          tenant: { type: "string" },
          user: { type: "string" },
          actor: { enum: ["human", "agent"] },
          ttl_seconds: {
            type: "integer",
            minimum: 30,
            maximum: 3600,
            default: 300,
          },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              retryable: { type: "boolean" },
              request_id: { type: "string" },
            },
          },
        },
      },
    },
  },
};
