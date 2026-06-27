import { z } from "zod";
import { RunIdSchema } from "@repo/platform-protocol";

const MemoryRunIdSchema = RunIdSchema.transform((value): string => value);

export const MemoryScopeSchema = z.enum(["run", "session"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryKindSchema = z.enum([
  "decision",
  "constraint",
  "fact",
  "todo",
  "artifact",
  "preference",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySourceSchema = z.enum([
  "user",
  "assistant",
  "planner",
  "task",
  "synthesis",
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryEventSchema = z.object({
  eventId: z.string().uuid(),
  idempotencyKey: z.string(),
  runId: MemoryRunIdSchema,
  sessionId: z.string(),
  taskId: z.string().uuid().optional(),
  scope: MemoryScopeSchema,
  kind: MemoryKindSchema,
  content: z.string().max(10000),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  source: MemorySourceSchema,
  createdAt: z.string().datetime(),
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

export const MemorySnapshotSchema = z.object({
  runId: MemoryRunIdSchema.optional(),
  sessionId: z.string(),
  summary: z.string().max(5000),
  constraints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  todos: z.array(z.string()).default([]),
  updatedAt: z.string().datetime(),
  version: z.number().int().min(1),
});
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

export const MemoryContextSchema = z.object({
  summary: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  relevantEvents: z.array(MemoryEventSchema).default([]),
  tokenEstimate: z.number().int().min(0).default(0),
});
export type MemoryContext = z.infer<typeof MemoryContextSchema>;

export interface MemoryRetrievalOptions {
  runId: string;
  sessionId: string;
  prompt: string;
  phase: "planning" | "execution" | "synthesis";
  maxTokens?: number;
  includePinned?: boolean;
}

export interface MemoryExtractionInput {
  runId: string;
  sessionId: string;
  taskId?: string;
  source: MemorySource;
  content: string;
  phase: "planning" | "execution" | "synthesis";
}

export const ReplayCheckpointSchema = z.object({
  checkpointId: z.string().uuid(),
  runId: MemoryRunIdSchema,
  sequence: z.number().int().min(0),
  phase: z.enum(["planning", "execution", "synthesis"]),
  runStatus: z.string(),
  taskStatuses: z.record(z.string()),
  memorySnapshotVersion: z.number().int(),
  memoryEventWatermark: z.number().int(),
  transcriptSequenceWatermark: z.number().int(),
  hash: z.string(),
  createdAt: z.string().datetime(),
});
export type ReplayCheckpoint = z.infer<typeof ReplayCheckpointSchema>;

export interface MemoryPolicyConfig {
  maxTokensPerContext: number;
  maxEventsPerRun: number;
  maxEventsPerSession: number;
  compactionThreshold: number;
  pinnedTag: string;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicyConfig = {
  maxTokensPerContext: 2000,
  maxEventsPerRun: 100,
  maxEventsPerSession: 500,
  compactionThreshold: 50,
  pinnedTag: "pinned",
};
