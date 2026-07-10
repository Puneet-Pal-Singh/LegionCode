import {
  JsonRecordSchema,
  JsonValueSchema,
  projectVisibleTranscriptText,
  type JsonRecord,
  type JsonValue,
  type TranscriptPart,
} from "@repo/platform-protocol";
import type { LLMUsage } from "../cost/index.js";
import type { LLMToolCall } from "./types.js";

export interface ProviderTranscriptPart {
  type: "visible_text" | "final" | "reasoning" | "tool_result" | "file";
  text?: string;
  result?: unknown;
  path?: string;
  change?: "created" | "modified" | "deleted" | "unchanged";
  reason?: string;
}

export interface TranscriptPartNormalizerInput {
  runId: string;
  turnId: string;
  providerId: string;
  providerParts?: readonly ProviderTranscriptPart[];
  providerText?: string;
  toolCalls?: readonly LLMToolCall[];
  usage?: LLMUsage;
  finishReason?: string;
  createdAt?: string;
}

export interface TranscriptPartNormalizer {
  normalize(input: TranscriptPartNormalizerInput): TranscriptPart[];
}

/**
 * Temporary adapter quarantine for providers that still return one text field.
 * Provider-native structured parts must replace this adapter before it is
 * removed. The parser is bounded and adapter-owned; no client or finalizer may
 * inspect its text output to decide transcript visibility.
 */
export class LegacyProviderTranscriptPartNormalizer implements TranscriptPartNormalizer {
  normalize(input: TranscriptPartNormalizerInput): TranscriptPart[] {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const parts: TranscriptPart[] = [];
    let sequence = 0;

    for (const providerPart of input.providerParts ?? []) {
      const part = buildProviderPart(providerPart, input, sequence++, createdAt);
      if (part) parts.push(part);
    }

    if (!input.providerParts?.length && input.providerText?.trim()) {
      for (const parsed of parseLegacyProviderText(input.providerText)) {
        parts.push(buildTextPart(parsed, input, sequence++, createdAt));
      }
      parts.push({
        id: stablePartId(input.turnId, sequence, "raw-provider-material"),
        schemaVersion: 1,
        runId: input.runId,
        turnId: input.turnId,
        sequence: sequence++,
        createdAt,
        type: "raw_provider_material",
        visibility: "audit_only",
        providerId: input.providerId,
        format: "legacy-provider-text",
        material: { text: input.providerText },
      });
    }

    for (const toolCall of input.toolCalls ?? []) {
      parts.push({
        id: stablePartId(input.turnId, sequence, toolCall.id),
        schemaVersion: 1,
        runId: input.runId,
        turnId: input.turnId,
        sequence: sequence++,
        createdAt,
        type: "tool_call",
        visibility: "audit_only",
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        input: toJsonRecord(toolCall.args),
      });
    }

    if (input.usage) {
      parts.push({
        id: stablePartId(input.turnId, sequence, "usage"),
        schemaVersion: 1,
        runId: input.runId,
        turnId: input.turnId,
        sequence: sequence++,
        createdAt,
        type: "usage",
        visibility: "audit_only",
        usage: toJsonRecord(input.usage),
      });
    }

    if (input.finishReason && input.finishReason !== "stop") {
      parts.push({
        id: stablePartId(input.turnId, sequence, "finish"),
        schemaVersion: 1,
        runId: input.runId,
        turnId: input.turnId,
        sequence: sequence++,
        createdAt,
        type: "error",
        visibility: "audit_only",
        code: "model.finish_reason",
        message: input.finishReason,
      });
    }

    return parts;
  }
}

export function visibleTextFromTranscriptParts(parts: readonly TranscriptPart[]): string {
  return projectVisibleTranscriptText(parts);
}

function buildProviderPart(
  providerPart: ProviderTranscriptPart,
  input: TranscriptPartNormalizerInput,
  sequence: number,
  createdAt: string,
): TranscriptPart | null {
  const id = stablePartId(input.turnId, sequence, providerPart.type);
  const base = {
    id,
    schemaVersion: 1 as const,
    runId: input.runId,
    turnId: input.turnId,
    sequence,
    createdAt,
  };
  if (providerPart.type === "file" && providerPart.path && providerPart.change) {
    return { ...base, type: "file", visibility: "audit_only", path: providerPart.path, change: providerPart.change };
  }
  if (providerPart.type === "tool_result") {
    return { ...base, type: "tool_result", visibility: "audit_only", result: toJsonValue(providerPart.result ?? providerPart.text ?? null), isError: false };
  }
  if (providerPart.type === "reasoning" && providerPart.text) {
    return { ...base, type: "reasoning", visibility: "audit_only", text: providerPart.text, reason: providerPart.reason };
  }
  if ((providerPart.type === "visible_text" || providerPart.type === "final") && providerPart.text) {
    return providerPart.type === "final"
      ? { ...base, type: "final", visibility: "visible", text: providerPart.text }
      : { ...base, type: "visible_text", visibility: "visible", text: providerPart.text, finalized: false };
  }
  return null;
}

function buildTextPart(
  parsed: { kind: "visible_text" | "reasoning"; text: string; reason?: string },
  input: TranscriptPartNormalizerInput,
  sequence: number,
  createdAt: string,
): TranscriptPart {
  const base = {
    id: stablePartId(input.turnId, sequence, parsed.kind),
    schemaVersion: 1 as const,
    runId: input.runId,
    turnId: input.turnId,
    sequence,
    createdAt,
  };
  return parsed.kind === "reasoning"
    ? { ...base, type: "reasoning", visibility: "audit_only", text: parsed.text, reason: parsed.reason }
    : { ...base, type: "visible_text", visibility: "visible", text: parsed.text, finalized: false };
}

function parseLegacyProviderText(text: string): Array<{ kind: "visible_text" | "reasoning"; text: string; reason?: string }> {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  if (!normalized) return [];
  const tagged = parseTaggedSegments(normalized);
  if (tagged.length > 0) return tagged;

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const labels = new Set(["user says", "intent", "context", "direct answer", "helpful details"]);
  const labeled = lines.length >= 3 && lines.every((line) => labels.has(line.slice(0, line.indexOf(":" )).replace(/^[-*•]\s*/, "").trim().toLowerCase()));
  if (labeled) return [{ kind: "reasoning", text: normalized, reason: "legacy_labeled_outline_quarantine" }];
  return [{ kind: "visible_text", text: normalized }];
}

function parseTaggedSegments(text: string): Array<{ kind: "visible_text" | "reasoning"; text: string; reason?: string }> {
  const tags = ["analysis", "thinking", "reasoning", "internal"];
  const parts: Array<{ kind: "visible_text" | "reasoning"; text: string; reason?: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = findOpeningTag(text, cursor, tags);
    if (!start) break;
    const visible = text.slice(cursor, start.index).trim();
    if (visible) parts.push({ kind: "visible_text", text: visible });
    const close = `</${start.tag}>`;
    const end = text.toLowerCase().indexOf(close, start.end);
    if (end < 0) return [];
    const reasoning = text.slice(start.end, end).trim();
    if (reasoning) parts.push({ kind: "reasoning", text: reasoning, reason: "legacy_provider_tag_quarantine" });
    cursor = end + close.length;
  }
  const tail = text.slice(cursor).trim();
  if (tail) parts.push({ kind: "visible_text", text: tail });
  return parts.length > 0 && parts.some((part) => part.kind === "reasoning") ? parts : [];
}

function findOpeningTag(text: string, from: number, tags: readonly string[]): { index: number; end: number; tag: string } | null {
  const lower = text.toLowerCase();
  let best: { index: number; end: number; tag: string } | null = null;
  for (const tag of tags) {
    const marker = `<${tag}>`;
    const index = lower.indexOf(marker, from);
    if (index >= 0 && (!best || index < best.index)) best = { index, end: index + marker.length, tag };
  }
  return best;
}

function stablePartId(turnId: string, sequence: number, providerPartId: string): string {
  return `transcript_${turnId}_${sequence}_${providerPartId}`;
}

function toJsonRecord(value: object): JsonRecord {
  const parsed = JsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function toJsonValue(value: unknown): JsonValue {
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
