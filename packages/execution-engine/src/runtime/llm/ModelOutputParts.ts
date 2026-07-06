import type { LLMToolCall } from "./types.js";
import type { LLMUsage } from "../cost/index.js";

export type NormalizedModelPart =
  | {
      type: "visible_text";
      text: string;
    }
  | {
      type: "reasoning";
      text: string;
      visibility: "audit_only";
      reason?: string;
    }
  | {
      type: "tool_call";
      toolCall: LLMToolCall;
    }
  | {
      type: "tool_result";
      text: string;
      toolCallId?: string;
    }
  | {
      type: "file";
      mediaType?: string;
      name?: string;
      data?: string;
    }
  | {
      type: "usage";
      usage: LLMUsage;
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "final";
      text: string;
    };

export interface NormalizeModelOutputPartsInput {
  text?: string;
  toolCalls?: LLMToolCall[];
  usage?: LLMUsage;
  finishReason?: string;
}

const INTERNAL_TAG_PATTERN =
  /<(analysis|thinking|reasoning|internal)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const TOOL_RESULT_TAG_PATTERN =
  /<tool_result\b[^>]*>([\s\S]*?)<\/tool_result>/gi;
const LABELED_OUTLINE_LINE_PATTERN =
  /^\s*(?:[-*•]\s*)?[A-Z][A-Za-z /-]{1,36}\s*[:.-]\s+\S/;

export function normalizeModelOutputParts(
  input: NormalizeModelOutputPartsInput,
): NormalizedModelPart[] {
  const parts: NormalizedModelPart[] = [];
  const textParts = normalizeTextParts(input.text ?? "");
  parts.push(...textParts);

  for (const toolCall of input.toolCalls ?? []) {
    parts.push({ type: "tool_call", toolCall });
  }

  if (input.usage) {
    parts.push({ type: "usage", usage: input.usage });
  }

  if (input.finishReason && input.finishReason !== "stop") {
    parts.push({
      type: "error",
      code: "model.finish_reason",
      message: input.finishReason,
    });
  }

  return parts;
}

export function getVisibleModelText(parts: readonly NormalizedModelPart[]): string {
  return parts
    .filter(
      (part): part is Extract<NormalizedModelPart, { type: "visible_text" | "final" }> =>
        part.type === "visible_text" || part.type === "final",
    )
    .map((part) => part.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
}

function normalizeTextParts(text: string): NormalizedModelPart[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const taggedParts = extractTaggedParts(normalized);
  if (taggedParts.length > 0) {
    return taggedParts;
  }

  if (looksLikePlanningOutline(normalized)) {
    return [
      {
        type: "reasoning",
        text: normalized,
        visibility: "audit_only",
        reason: "dense_labeled_outline",
      },
    ];
  }

  return [{ type: "visible_text", text: collapseExcessBlankLines(normalized) }];
}

function extractTaggedParts(text: string): NormalizedModelPart[] {
  const matches = [
    ...findTaggedMatches(text, INTERNAL_TAG_PATTERN, "reasoning"),
    ...findTaggedMatches(text, TOOL_RESULT_TAG_PATTERN, "tool_result"),
  ].sort((left, right) => left.index - right.index);

  if (matches.length === 0) {
    return [];
  }

  const parts: NormalizedModelPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    const visibleText = text.slice(cursor, match.index).trim();
    if (visibleText) {
      parts.push({ type: "visible_text", text: collapseExcessBlankLines(visibleText) });
    }

    const innerText = match.text.trim();
    if (innerText) {
      if (match.kind === "tool_result") {
        parts.push({ type: "tool_result", text: collapseExcessBlankLines(innerText) });
      } else {
        parts.push({
          type: "reasoning",
          text: collapseExcessBlankLines(innerText),
          visibility: "audit_only",
          reason: "provider_internal_tag",
        });
      }
    }
    cursor = match.index + match.raw.length;
  }

  const tailText = text.slice(cursor).trim();
  if (tailText) {
    parts.push({ type: "visible_text", text: collapseExcessBlankLines(tailText) });
  }

  return parts;
}

function findTaggedMatches(
  text: string,
  pattern: RegExp,
  kind: "reasoning" | "tool_result",
): Array<{ index: number; raw: string; text: string; kind: "reasoning" | "tool_result" }> {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index ?? 0,
    raw: match[0] ?? "",
    text: match[2] ?? match[1] ?? "",
    kind,
  }));
}

function looksLikePlanningOutline(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    return false;
  }

  const labeledLineCount = lines.filter((line) =>
    LABELED_OUTLINE_LINE_PATTERN.test(line),
  ).length;
  return labeledLineCount >= 3 && labeledLineCount >= Math.ceil(lines.length / 2);
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
