import { z } from "zod";
import { JsonRecordSchema, JsonValueSchema, ProtocolTimestampSchema } from "./common.js";

export const TRANSCRIPT_PART_SCHEMA_VERSION = 1;

export const TranscriptPartIdSchema = z.string().min(1).max(200);
export type TranscriptPartId = z.infer<typeof TranscriptPartIdSchema>;
const TranscriptCorrelationShape = {
  id: TranscriptPartIdSchema,
  schemaVersion: z.literal(TRANSCRIPT_PART_SCHEMA_VERSION),
  runId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  createdAt: ProtocolTimestampSchema,
  providerPartId: z.string().min(1).max(200).optional(),
  parentPartId: TranscriptPartIdSchema.optional(),
} as const;

const VisibleTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("visible_text"),
    visibility: z.literal("visible"),
    text: z.string(),
    finalized: z.boolean(),
  })
  .strict();

const FinalTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("final"),
    visibility: z.literal("visible"),
    text: z.string(),
  })
  .strict();

const ReasoningTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("reasoning"),
    visibility: z.literal("audit_only"),
    text: z.string(),
    reason: z.string().min(1).max(160).optional(),
  })
  .strict();

const ToolCallTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("tool_call"),
    visibility: z.literal("audit_only"),
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(160),
    input: JsonRecordSchema,
  })
  .strict();

const ToolResultTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("tool_result"),
    visibility: z.literal("audit_only"),
    toolCallId: z.string().min(1).max(200).optional(),
    result: JsonValueSchema,
    isError: z.boolean(),
  })
  .strict();

const FileTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("file"),
    visibility: z.literal("audit_only"),
    path: z.string().min(1).max(4_096),
    change: z.enum(["created", "modified", "deleted", "unchanged"]),
    artifactId: z.string().min(1).max(200).optional(),
  })
  .strict();

const UsageTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("usage"),
    visibility: z.literal("audit_only"),
    usage: JsonRecordSchema,
  })
  .strict();

const ErrorTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("error"),
    visibility: z.literal("audit_only"),
    code: z.string().min(1).max(160),
    message: z.string(),
  })
  .strict();

const TerminalReferenceTranscriptPartSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("terminal_reference"),
    visibility: z.literal("audit_only"),
    terminalState: z.string().min(1).max(160),
    artifactIds: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict();

const RawProviderMaterialSchema = z
  .object({
    ...TranscriptCorrelationShape,
    type: z.literal("raw_provider_material"),
    visibility: z.literal("audit_only"),
    providerId: z.string().min(1).max(160),
    format: z.string().min(1).max(80),
    material: JsonValueSchema,
  })
  .strict();

export const TranscriptPartSchema = z.discriminatedUnion("type", [
  VisibleTranscriptPartSchema,
  FinalTranscriptPartSchema,
  ReasoningTranscriptPartSchema,
  ToolCallTranscriptPartSchema,
  ToolResultTranscriptPartSchema,
  FileTranscriptPartSchema,
  UsageTranscriptPartSchema,
  ErrorTranscriptPartSchema,
  TerminalReferenceTranscriptPartSchema,
  RawProviderMaterialSchema,
]);
export type TranscriptPart = z.infer<typeof TranscriptPartSchema>;

export const TranscriptPartDeltaSchema = z
  .object({
    type: z.literal("transcript_part.delta"),
    schemaVersion: z.literal(TRANSCRIPT_PART_SCHEMA_VERSION),
    partId: TranscriptPartIdSchema,
    runId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative(),
    createdAt: ProtocolTimestampSchema,
    target: z.enum(["visible_text", "final", "reasoning", "tool_result", "error"]),
    delta: z.string(),
  })
  .strict();
export type TranscriptPartDelta = z.infer<typeof TranscriptPartDeltaSchema>;

export const TranscriptPartEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transcript_part.created"),
    schemaVersion: z.literal(TRANSCRIPT_PART_SCHEMA_VERSION),
    part: TranscriptPartSchema,
  }).strict(),
  TranscriptPartDeltaSchema,
  z.object({
    type: z.literal("transcript_part.completed"),
    schemaVersion: z.literal(TRANSCRIPT_PART_SCHEMA_VERSION),
    part: TranscriptPartSchema,
  }).strict(),
]);
export type TranscriptPartEvent = z.infer<typeof TranscriptPartEventSchema>;

export function isVisibleTranscriptPart(
  part: TranscriptPart,
): part is Extract<TranscriptPart, { visibility: "visible" }> {
  return part.visibility === "visible" && (part.type === "visible_text" || part.type === "final");
}

export function projectVisibleTranscriptText(parts: readonly TranscriptPart[]): string {
  return parts
    .filter(isVisibleTranscriptPart)
    .map((part) => part.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
}

export function replayTranscriptPartEvents(
  events: readonly TranscriptPartEvent[],
): TranscriptPart[] {
  const parts = new Map<string, TranscriptPart>();
  for (const event of events) {
    const parsed = TranscriptPartEventSchema.parse(event);
    if (parsed.type === "transcript_part.created" || parsed.type === "transcript_part.completed") {
      const current = parts.get(parsed.part.id);
      if (parsed.type === "transcript_part.created" && current) {
        throw new Error(`Transcript part ${parsed.part.id} was created more than once`);
      }
      if (current && (current.runId !== parsed.part.runId || current.turnId !== parsed.part.turnId)) {
        throw new Error(`Transcript part ${parsed.part.id} changed correlation during replay`);
      }
      parts.set(parsed.part.id, parsed.part);
      continue;
    }

    const part = parts.get(parsed.partId);
    if (!part) {
      throw new Error(`Transcript delta references unknown part ${parsed.partId}`);
    }
    if (part.runId !== parsed.runId || part.turnId !== parsed.turnId) {
      throw new Error(`Transcript delta correlation does not match part ${parsed.partId}`);
    }
    if (part.type !== parsed.target || !("text" in part)) {
      throw new Error(`Transcript delta target ${parsed.target} does not match part ${parsed.partId}`);
    }
    parts.set(parsed.partId, { ...part, text: `${part.text}${parsed.delta}` } as TranscriptPart);
  }
  return [...parts.values()].sort((left, right) => left.sequence - right.sequence);
}
