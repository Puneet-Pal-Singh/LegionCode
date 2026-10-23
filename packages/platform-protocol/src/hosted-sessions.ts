import { z } from "zod";
import { RunIdSchema } from "./ids.js";
import { TurnIdSchema } from "./ids.js";
import { HostedWorkspaceRepositorySchema } from "./hosted-workspaces.js";

// Hosted records use persisted session UUIDs, independent of local Thread IDs.
export const HostedSessionParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const HostedSessionWorkspaceContextRequestSchema = HostedSessionParamsSchema.extend({
  runId: RunIdSchema.optional(),
}).strict();
export const HostedSessionWorkspaceContextSchema = z.object({
  sessionId: z.string().uuid(),
  workspaceId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  workspaceStatus: z.enum(["active", "archived"]).nullable(),
  repository: HostedWorkspaceRepositorySchema.nullable(),
  selectedBranch: z.string().min(1).nullable(),
  runBranch: z.string().min(1).nullable(),
}).strict();
export const HostedSessionPullRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  title: z.string().min(1),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
}).strict();
export const HostedSessionPullRequestsResponseSchema = z.discriminatedUnion("status", [
  z.object({
    sessionId: z.string().uuid(),
    status: z.literal("available"),
    pullRequests: z.array(HostedSessionPullRequestSchema),
  }).strict(),
  z.object({
    sessionId: z.string().uuid(),
    status: z.literal("unavailable"),
  }).strict(),
]);
export const HostedSessionReadReceiptRequestSchema = HostedSessionParamsSchema.extend({ terminalTurnId: TurnIdSchema }).strict();
export const HostedSessionReadReceiptSchema = z.object({
  sessionId: z.string().uuid(),
  lastAcknowledgedTerminalTurnId: TurnIdSchema,
  acknowledgedAt: z.string().datetime(),
}).strict();
export const HostedSessionCreateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  runId: RunIdSchema.optional(),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  repository: z.string().trim().min(1).max(240).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
}).strict();
export const HostedSessionRenameRequestSchema = HostedSessionParamsSchema.extend({
  title: z.string().trim().min(1).max(80),
}).strict();

export const HostedSessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  taskId: z.string().min(1),
  title: z.string(),
  titleSource: z.enum(["preview", "generated", "user"]),
  titleVersion: z.number().int().positive().optional(),
  repository: z.string().nullable(),
  activeRunId: z.string().min(1).nullable(),
  latestRunId: z.string().min(1).nullable().optional(),
  mode: z.string(),
  status: z.enum(["idle", "running", "completed", "paused", "failed", "waiting_for_approval"]),
  pinnedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  titleStatus: z.enum(["pending", "ready", "failed"]).optional(),
  lastTerminalTurnId: TurnIdSchema.nullable().optional(),
  lastAcknowledgedTerminalTurnId: TurnIdSchema.nullable().optional(),
}).strict();
export const HostedTaskSchema = z.object({
  id: z.string().min(1), userId: z.string().min(1), workspaceId: z.string().nullable(),
  title: z.string(), status: z.enum(["active", "archived"]),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
}).strict();
export const HostedSessionsResponseSchema = z.object({
  tasks: z.array(HostedTaskSchema), sessions: z.array(HostedSessionSchema),
}).strict();
export const HostedArchivedSessionsResponseSchema = z.object({ sessions: z.array(HostedSessionSchema) }).strict();
export const HostedSessionResponseSchema = z.object({ session: HostedSessionSchema }).strict();

export type HostedSession = z.infer<typeof HostedSessionSchema>;
export type HostedSessionWorkspaceContext = z.infer<typeof HostedSessionWorkspaceContextSchema>;
export type HostedSessionWorkspaceContextRequest = z.infer<typeof HostedSessionWorkspaceContextRequestSchema>;
export type HostedSessionPullRequest = z.infer<typeof HostedSessionPullRequestSchema>;
export type HostedSessionPullRequestsResponse = z.infer<typeof HostedSessionPullRequestsResponseSchema>;
export type HostedSessionReadReceipt = z.infer<typeof HostedSessionReadReceiptSchema>;
export type HostedSessionCreateRequest = z.input<typeof HostedSessionCreateRequestSchema>;
export type HostedSessionRenameRequest = z.infer<typeof HostedSessionRenameRequestSchema>;
export type HostedSessionsResponse = z.infer<typeof HostedSessionsResponseSchema>;
