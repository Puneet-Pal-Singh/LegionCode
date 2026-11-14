import { z } from "zod";

export const THREAD_TITLE_MAX_CHARACTERS = 50;

/** Codex-style envelope; code-point validation also applies to plain-text routes. */
export const ThreadTitleOutputSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .describe("One natural task title, at most 50 characters"),
  })
  .strict();

export type TitleOutputFailure =
  | "empty_output"
  | "malformed_output"
  | "multiline_output"
  | "title_too_long"
  | "meta_narration";

export type DecodedThreadTitle =
  | { ok: true; title: string }
  | { ok: false; reason: TitleOutputFailure };

export function decodeThreadTitle(value: unknown): DecodedThreadTitle {
  if (typeof value !== "string") {
    const envelope = ThreadTitleOutputSchema.safeParse(value);
    return envelope.success
      ? validateTitle(envelope.data.title)
      : { ok: false, reason: "malformed_output" };
  }
  const cleaned = value.replace(/<think>[\s\S]*?<\/think>\s*/giu, "").trim();
  if (cleaned.startsWith("{")) {
    try {
      return decodeThreadTitle(JSON.parse(cleaned) as unknown);
    } catch {
      return { ok: false, reason: "malformed_output" };
    }
  }
  if (/```|<\/?think>/iu.test(cleaned)) {
    return { ok: false, reason: "malformed_output" };
  }
  return validateTitle(cleaned);
}

function validateTitle(value: string): DecodedThreadTitle {
  const trimmed = value.trim();
  if (/\r|\n/u.test(trimmed)) return { ok: false, reason: "multiline_output" };
  const title = trimmed
    .replace(/^title\s*:\s*/iu, "")
    .replace(/^["'`“‘]+|["'`”’]+$/gu, "")
    .replace(/[\p{C}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (!title) return { ok: false, reason: "empty_output" };
  if (Array.from(title).length > THREAD_TITLE_MAX_CHARACTERS) {
    return { ok: false, reason: "title_too_long" };
  }
  if (
    /^(?:[-*+•]|#{1,6})\s/u.test(title) ||
    /^(?:input|prompt|instructions?|system|assistant)\s*:/iu.test(title) ||
    /^(?:the )?user(?:'s)?\s+(?:goal|request|task|wants? me|is asking)\b/iu.test(
      title,
    ) ||
    /^(?:we|i|let(?:'s| us| me)|the task)\b.{0,48}\b(?:generate|create|write|output|produce|return|provide)\b.{0,32}\btitle\b/iu.test(
      title,
    ) ||
    /^(?:return|output|respond with|provide)\s+(?:only\s+)?(?:one|a|the)\s+(?:(?:plain-text|concise|brief|chat|thread|conversation)\s+)*title\b/iu.test(
      title,
    ) ||
    /^(?:generate|create|write)\s+(?:a|one)\s+(?:(?:concise|brief|chat|thread|conversation)\s+)*title\s+for\s+(?:(?:this|the|a)\s+)?(?:conversation|chat|thread|user request)\b/iu.test(
      title,
    )
  )
    return { ok: false, reason: "meta_narration" };
  return { ok: true, title };
}

export function normalizeGeneratedTitle(value: unknown): string | null {
  const result = decodeThreadTitle(value);
  return result.ok ? result.title : null;
}
