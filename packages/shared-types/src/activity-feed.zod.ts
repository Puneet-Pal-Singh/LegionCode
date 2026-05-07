import { z } from "zod";
import {
  ACTIVITY_PART_KINDS,
  APPROVAL_ACTIVITY_STATUSES,
  COMMENTARY_ACTIVITY_PHASES,
  COMMENTARY_ACTIVITY_STATUSES,
  HANDOFF_ACTIVITY_STATUSES,
  REASONING_ACTIVITY_STATUSES,
  TOOL_ACTIVITY_FAMILIES,
  TOOL_ACTIVITY_STATUSES,
  type ActivityFeedSnapshot,
  type ActivityPart,
  type ToolActivityMetadata,
} from "./activity-feed.js";

const EventSourceSchema = z.enum(["brain", "muscle", "web", "cli", "desktop"]);

const BaseActivityPartSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: EventSourceSchema,
});

const TextActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.TEXT),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const CommentaryActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.COMMENTARY),
  phase: z.enum([
    COMMENTARY_ACTIVITY_PHASES.COMMENTARY,
    COMMENTARY_ACTIVITY_PHASES.FINAL_ANSWER,
  ]),
  status: z.enum([
    COMMENTARY_ACTIVITY_STATUSES.ACTIVE,
    COMMENTARY_ACTIVITY_STATUSES.COMPLETED,
  ]),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ReasoningActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.REASONING),
  label: z.string().min(1),
  summary: z.string(),
  phase: z.enum(["planning", "execution", "synthesis"]),
  status: z.enum([
    REASONING_ACTIVITY_STATUSES.ACTIVE,
    REASONING_ACTIVITY_STATUSES.COMPLETED,
  ]),
}).strict();

const ReadToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.READ),
  displayText: z.string().optional(),
  path: z.string().optional(),
  count: z.number().int().min(0),
  truncated: z.boolean(),
  preview: z.string().optional(),
  loadedPaths: z.array(z.string()),
});

const SearchToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.SEARCH),
  displayText: z.string().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  count: z.number().int().min(0),
  truncated: z.boolean(),
  preview: z.string().optional(),
  loadedPaths: z.array(z.string()),
});

const ShellToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.SHELL),
  displayText: z.string().optional(),
  command: z.string().min(1),
  description: z.string().optional(),
  cwd: z.string().optional(),
  origin: z.enum(["user_shell", "agent_tool"]),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  outputTail: z.string().optional(),
  exitCode: z.number().int().optional(),
  truncated: z.boolean(),
});

const EditToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.EDIT),
  displayText: z.string().optional(),
  filePath: z.string().min(1),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  diffPreview: z.string().optional(),
  restorationContent: z.string().optional(),
  diagnostics: z.array(z.string()).optional(),
});

const GitToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.GIT),
  displayText: z.string().optional(),
  pluginLabel: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  path: z.string().optional(),
  count: z.number().int().min(0).optional(),
  preview: z.string().optional(),
  commitIdentitySource: z
    .enum([
      "workspace_git_config",
      "persisted_preference",
      "github_profile",
      "user_input",
    ])
    .optional(),
  commitIdentityVerified: z.boolean().optional(),
});

const GenericToolMetadataSchema = z.object({
  family: z.literal(TOOL_ACTIVITY_FAMILIES.GENERIC),
  displayText: z.string().optional(),
  summary: z.string().optional(),
});

const ToolActivityMetadataSchema = z.discriminatedUnion("family", [
  ReadToolMetadataSchema,
  SearchToolMetadataSchema,
  ShellToolMetadataSchema,
  EditToolMetadataSchema,
  GitToolMetadataSchema,
  GenericToolMetadataSchema,
]);

const ToolActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.TOOL),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum([
    TOOL_ACTIVITY_STATUSES.REQUESTED,
    TOOL_ACTIVITY_STATUSES.RUNNING,
    TOOL_ACTIVITY_STATUSES.COMPLETED,
    TOOL_ACTIVITY_STATUSES.FAILED,
  ]),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown().optional(),
  metadata: ToolActivityMetadataSchema,
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
}).strict();

const ApprovalActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.APPROVAL),
  approvalType: z.enum(["permission", "workspace_bootstrap"]),
  status: z.enum([
    APPROVAL_ACTIVITY_STATUSES.REQUESTED,
    APPROVAL_ACTIVITY_STATUSES.GRANTED,
    APPROVAL_ACTIVITY_STATUSES.DENIED,
    APPROVAL_ACTIVITY_STATUSES.EXPIRED,
  ]),
  summary: z.string().min(1),
  details: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();

const HandoffActivityPartSchema = BaseActivityPartSchema.extend({
  kind: z.literal(ACTIVITY_PART_KINDS.HANDOFF),
  targetMode: z.literal("build"),
  summary: z.string().min(1),
  prompt: z.string().min(1),
  status: z.enum([
    HANDOFF_ACTIVITY_STATUSES.READY,
    HANDOFF_ACTIVITY_STATUSES.ACCEPTED,
    HANDOFF_ACTIVITY_STATUSES.DISMISSED,
  ]),
}).strict();

export const ActivityPartSchema = z.discriminatedUnion("kind", [
  TextActivityPartSchema,
  CommentaryActivityPartSchema,
  ReasoningActivityPartSchema,
  ToolActivityPartSchema,
  ApprovalActivityPartSchema,
  HandoffActivityPartSchema,
]);

export const ActivityFeedSnapshotSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    status: z.string().nullable(),
    items: z.array(ActivityPartSchema),
  })
  .strict();

export function parseActivityPart(data: unknown): ActivityPart {
  return ActivityPartSchema.parse(data) as ActivityPart;
}

export function safeParseActivityPart(
  data: unknown,
): { success: true; data: ActivityPart } | { success: false; error: string } {
  const result = ActivityPartSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as ActivityPart };
  }
  return { success: false, error: result.error.message };
}

export function parseActivityFeedSnapshot(data: unknown): ActivityFeedSnapshot {
  return ActivityFeedSnapshotSchema.parse(data) as ActivityFeedSnapshot;
}

export function safeParseToolActivityMetadata(
  data: unknown,
): { success: true; data: ToolActivityMetadata } | { success: false; error: string } {
  const result = ToolActivityMetadataSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as ToolActivityMetadata };
  }
  return { success: false, error: result.error.message };
}
