import type { ProviderTranscriptPart } from "@shadowbox/execution-engine/runtime/llm";

/**
 * Preserve the model-visible text boundaries produced by the AI SDK.
 * Reasoning is intentionally not inferred here: providers must explicitly
 * designate a safe summary before it can enter the user-visible lifecycle.
 */
export function visiblePartsFromGenerateTextResult(result: {
  text: string;
  steps?: readonly { text?: string }[];
}): readonly ProviderTranscriptPart[] {
  const parts = (result.steps ?? [])
    .map((step) => step.text?.trim())
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ type: "visible_text" as const, text }));
  return parts.length > 0 || !result.text.trim()
    ? parts
    : [{ type: "visible_text", text: result.text }];
}
