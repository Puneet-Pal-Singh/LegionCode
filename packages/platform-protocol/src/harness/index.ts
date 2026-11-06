import { z } from "zod";
import { ModelIdSchema, RunAttemptIdSchema, RunIdSchema, ThreadIdSchema, TurnIdSchema, UserIdSchema, WorkspaceIdSchema } from "../ids.js";

const OpaqueId = z.string().min(1).max(256);
const Generation = z.number().int().safe().nonnegative();
export const HarnessKindSchema = z.enum(["codex", "claude", "opencode"]);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/** Immutable admission selection. External IDs learned after admission live separately. */
export const HarnessSelectionSchema = z.object({
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  environmentId: OpaqueId,
  workspaceGrantId: OpaqueId,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  harness: HarnessKindSchema,
  instanceId: OpaqueId,
  connectionId: OpaqueId,
  authOwnerGeneration: Generation,
  modelId: ModelIdSchema,
  policyId: OpaqueId,
  policyRevision: OpaqueId,
  billingSource: z.enum(["api_key", "subscription", "external"]),
  runtimeVersion: OpaqueId,
  protocolVersion: OpaqueId,
  transport: z.enum(["codex_app_server_stdio", "claude_agent_sdk", "opencode_v2"]),
}).strict().readonly();
export type HarnessSelection = z.infer<typeof HarnessSelectionSchema>;

export const HarnessCapabilitiesSchema = z.object({
  approvals: z.boolean(),
  questions: z.boolean(),
  steer: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  images: z.boolean(),
  terminal: z.boolean(),
  contextTelemetry: z.boolean(),
  accountQuota: z.boolean(),
  experimental: z.boolean(),
}).strict().readonly();
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;
