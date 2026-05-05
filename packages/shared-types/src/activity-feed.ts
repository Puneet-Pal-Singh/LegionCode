import type { RunMode } from "./run-mode.js";
import type { EventSource } from "./run-events.js";
import type { GitCommitIdentitySource } from "./git.js";

export const ACTIVITY_PART_KINDS = {
  TEXT: "text",
  COMMENTARY: "commentary",
  REASONING: "reasoning",
  TOOL: "tool",
  APPROVAL: "approval",
  HANDOFF: "handoff",
} as const;

export type ActivityPartKind =
  (typeof ACTIVITY_PART_KINDS)[keyof typeof ACTIVITY_PART_KINDS];

export const TOOL_ACTIVITY_STATUSES = {
  REQUESTED: "requested",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type ToolActivityStatus =
  (typeof TOOL_ACTIVITY_STATUSES)[keyof typeof TOOL_ACTIVITY_STATUSES];

export const REASONING_ACTIVITY_STATUSES = {
  ACTIVE: "active",
  COMPLETED: "completed",
} as const;

export type ReasoningActivityStatus =
  (typeof REASONING_ACTIVITY_STATUSES)[keyof typeof REASONING_ACTIVITY_STATUSES];

export const COMMENTARY_ACTIVITY_PHASES = {
  COMMENTARY: "commentary",
  FINAL_ANSWER: "final_answer",
} as const;

export type CommentaryActivityPhase =
  (typeof COMMENTARY_ACTIVITY_PHASES)[keyof typeof COMMENTARY_ACTIVITY_PHASES];

export const COMMENTARY_ACTIVITY_STATUSES = {
  ACTIVE: "active",
  COMPLETED: "completed",
} as const;

export type CommentaryActivityStatus =
  (typeof COMMENTARY_ACTIVITY_STATUSES)[keyof typeof COMMENTARY_ACTIVITY_STATUSES];

export const APPROVAL_ACTIVITY_STATUSES = {
  REQUESTED: "requested",
  GRANTED: "granted",
  DENIED: "denied",
  EXPIRED: "expired",
} as const;

export type ApprovalActivityStatus =
  (typeof APPROVAL_ACTIVITY_STATUSES)[keyof typeof APPROVAL_ACTIVITY_STATUSES];

export const HANDOFF_ACTIVITY_STATUSES = {
  READY: "ready",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const;

export type HandoffActivityStatus =
  (typeof HANDOFF_ACTIVITY_STATUSES)[keyof typeof HANDOFF_ACTIVITY_STATUSES];

export const TOOL_ACTIVITY_FAMILIES = {
  READ: "read",
  SEARCH: "search",
  SHELL: "shell",
  EDIT: "edit",
  GIT: "git",
  GENERIC: "generic",
} as const;

export type ToolActivityFamily =
  (typeof TOOL_ACTIVITY_FAMILIES)[keyof typeof TOOL_ACTIVITY_FAMILIES];

export interface ActivityPartBase<
  TKind extends ActivityPartKind = ActivityPartKind,
> {
  id: string;
  runId: string;
  sessionId?: string;
  turnId?: string;
  kind: TKind;
  createdAt: string;
  updatedAt: string;
  source: EventSource;
}

export interface TextActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.TEXT
> {
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CommentaryActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.COMMENTARY
> {
  phase: CommentaryActivityPhase;
  status: CommentaryActivityStatus;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ReasoningActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.REASONING
> {
  label: string;
  summary: string;
  phase: "planning" | "execution" | "synthesis";
  status: ReasoningActivityStatus;
}

export interface ReadToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.READ;
  displayText?: string;
  path?: string;
  count: number;
  truncated: boolean;
  preview?: string;
  loadedPaths: string[];
}

export interface SearchToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.SEARCH;
  displayText?: string;
  path?: string;
  pattern?: string;
  count: number;
  truncated: boolean;
  preview?: string;
  loadedPaths: string[];
}

export interface ShellToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.SHELL;
  displayText?: string;
  command: string;
  description?: string;
  cwd?: string;
  origin: "user_shell" | "agent_tool";
  stdout?: string;
  stderr?: string;
  outputTail?: string;
  exitCode?: number;
  truncated: boolean;
}

export interface EditToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.EDIT;
  displayText?: string;
  filePath: string;
  additions: number;
  deletions: number;
  diffPreview?: string;
  restorationContent?: string;
  diagnostics?: string[];
}

export interface GitToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.GIT;
  displayText?: string;
  pluginLabel?: string;
  branch?: string;
  path?: string;
  count?: number;
  preview?: string;
  commitIdentitySource?: GitCommitIdentitySource;
  commitIdentityVerified?: boolean;
}

export interface GenericToolActivityMetadata {
  family: typeof TOOL_ACTIVITY_FAMILIES.GENERIC;
  displayText?: string;
  summary?: string;
}

export type ToolActivityMetadata =
  | ReadToolActivityMetadata
  | SearchToolActivityMetadata
  | ShellToolActivityMetadata
  | EditToolActivityMetadata
  | GitToolActivityMetadata
  | GenericToolActivityMetadata;

export interface ToolActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.TOOL
> {
  toolId: string;
  toolName: string;
  status: ToolActivityStatus;
  input?: Record<string, unknown>;
  output?: unknown;
  metadata: ToolActivityMetadata;
  startedAt?: string;
  endedAt?: string;
}

export interface ApprovalActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.APPROVAL
> {
  approvalType: "permission" | "workspace_bootstrap";
  status: ApprovalActivityStatus;
  summary: string;
  details?: string;
  expiresAt?: string;
}

export interface HandoffActivityPart extends ActivityPartBase<
  typeof ACTIVITY_PART_KINDS.HANDOFF
> {
  targetMode: Extract<RunMode, "build">;
  summary: string;
  prompt: string;
  status: HandoffActivityStatus;
}

export type ActivityPart =
  | TextActivityPart
  | CommentaryActivityPart
  | ReasoningActivityPart
  | ToolActivityPart
  | ApprovalActivityPart
  | HandoffActivityPart;

export interface ActivityFeedSnapshot {
  runId: string;
  sessionId?: string;
  status: string | null;
  items: ActivityPart[];
}

export function isActivityPart(value: unknown): value is ActivityPart {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" &&
    Object.values(ACTIVITY_PART_KINDS).includes(
      candidate.kind as ActivityPartKind,
    )
  );
}
