import { z } from "zod";
import {
  AppServerRequestSchema,
  AppServerResponseSchema,
  type AppServerRequest,
  type AppServerResponse,
} from "@legioncode/app-server/protocol";

export const HOSTED_REQUEST_CHANNEL = "desktop:hosted-request";
export const HOSTED_RESPONSE_CHANNEL = "desktop:hosted-response";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_IMAGE_REQUEST_BYTES = MAX_REQUEST_BYTES + 4 * Math.ceil(10 * 1024 * 1024 / 3) + 4 * 256;

export const HostedRequestScopeSchema = z.object({
  target: z.literal("production"),
  accountId: z.string().min(1).max(256),
  generation: z.number().int().safe().nonnegative(),
}).strict();
export type HostedRequestScope = z.infer<typeof HostedRequestScopeSchema>;

export const HostedRequestSchema = z.object({
  requestId: z.string().uuid(),
  scope: HostedRequestScopeSchema,
  serializedEnvelope: z.string().min(1).max(MAX_IMAGE_REQUEST_BYTES),
}).strict();
export type HostedRequest = z.infer<typeof HostedRequestSchema>;

const AcknowledgementIdSchema = z.string().max(256).nullable();
export const HostedResponseMetadataSchema = z.object({
  status: z.number().int().min(100).max(599),
  runId: AcknowledgementIdSchema,
  threadId: AcknowledgementIdSchema,
  turnId: AcknowledgementIdSchema,
  runAttemptId: AcknowledgementIdSchema,
}).strict();
export type HostedResponseMetadata = z.infer<typeof HostedResponseMetadataSchema>;

export const HostedResponseEventSchema = z.object({
  requestId: z.string().uuid(),
  scope: HostedRequestScopeSchema,
  metadata: HostedResponseMetadataSchema,
}).strict();
export type HostedResponseEvent = z.infer<typeof HostedResponseEventSchema>;

const ResultShape = {
  requestId: z.string().uuid(),
  scope: HostedRequestScopeSchema,
  metadata: HostedResponseMetadataSchema.nullable(),
};
type HostedRequestResultBase = { requestId: string; scope: HostedRequestScope; metadata: HostedResponseMetadata | null };
export type HostedRequestResult = HostedRequestResultBase & (
  | { ok: true; payload: AppServerResponse }
  | { ok: false; error: {
      code: "transport" | "timeout" | "aborted" | "server_error" | "invalid_response";
      message: string;
      statusCode?: number;
    } }
);
export const HostedRequestResultSchema: z.ZodType<HostedRequestResult, z.ZodTypeDef, unknown> = z.discriminatedUnion("ok", [
  z.object({ ...ResultShape, ok: z.literal(true), payload: AppServerResponseSchema }).strict(),
  z.object({
    ...ResultShape,
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["transport", "timeout", "aborted", "server_error", "invalid_response"]),
      message: z.string().min(1).max(256),
      statusCode: z.number().int().min(100).max(599).optional(),
    }).strict(),
  }).strict(),
]);

const HOSTED_METHODS: ReadonlySet<AppServerRequest["method"]> = new Set([
  "initialize", "session/history", "session/list", "session/create", "session/rename",
  "session/pin", "session/unpin", "session/archive", "session/unarchive", "session/delete",
  "session/archived", "session/readReceipt", "session/workspaceContext", "session/pullRequests",
  "turn/reserve", "turn/submit", "turn/scope", "turn/interrupt", "turn/steer", "turn/resume",
  "thread/input/enqueue", "thread/input/list", "thread/input/update", "thread/input/remove",
  "thread/input/steer", "thread/input/start", "turn/lifecycleEvents", "turn/lifecycleEventChunk",
  "turn/diff", "turn/approval", "turn/compact", "artifact/reviewLatest", "artifact/reviewByMessage",
  "artifact/diff", "checkout/listFiles", "checkout/readFile", "git/status", "git/diff",
  "git/stage", "git/commit", "git/branch", "git/push", "git/pullRequest", "artifact/codeContent",
  "workspace/configuration/read", "workspace/configuration/update", "workspace/list", "workspace/select",
  "repository/list", "repository/branches", "repository/tree", "repository/contents",
  "provider/catalog", "provider/models", "provider/models/refresh", "provider/preferences/read",
  "provider/preferences/update", "provider/resolve", "provider/credentials/list",
  "provider/credentials/connect", "provider/credentials/update", "provider/credentials/disconnect",
  "provider/credentials/validate",
]);

/** These are the existing hosted ingress hints, derived only from a validated method. */
export function hostedRequestHeaders(method: AppServerRequest["method"]): Record<string, string> {
  return ["turn/submit", "turn/steer", "thread/input/enqueue", "thread/input/update", "provider/preferences/update"].includes(method)
    ? { "X-LegionCode-AppServer-Method": method }
    : {};
}

export function parseHostedEnvelope(serializedEnvelope: string): AppServerRequest {
  if (serializedEnvelope.length > MAX_IMAGE_REQUEST_BYTES) throw new Error("Hosted request is too large");
  const request = AppServerRequestSchema.parse(JSON.parse(serializedEnvelope));
  if (!HOSTED_METHODS.has(request.method)) throw new Error("Method is unavailable on the hosted connection");
  if ((request.method === "provider/preferences/read" || request.method === "provider/preferences/update") && request.params.localScope !== undefined) {
    throw new Error("Local provider scope cannot use the hosted connection");
  }
  const limit = Object.keys(hostedRequestHeaders(request.method)).length ? MAX_IMAGE_REQUEST_BYTES : MAX_REQUEST_BYTES;
  if (new TextEncoder().encode(serializedEnvelope).byteLength > limit) throw new Error("Hosted request is too large");
  return request;
}

export function sameHostedScope(left: HostedRequestScope, right: HostedRequestScope): boolean {
  return left.target === right.target && left.accountId === right.accountId && left.generation === right.generation;
}
