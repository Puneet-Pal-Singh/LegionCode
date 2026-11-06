import type { LLMRuntimeAIService, LLMTextResponse } from "./types.js";
import type {
  ProviderTranscriptPart,
  TranscriptPartNormalizer,
} from "./TranscriptPartNormalizer.js";

/** One response projection for hosted gateways and protected local inference. */
export function normalizeProviderTextResponse(input: {
  readonly result: Awaited<ReturnType<LLMRuntimeAIService["generateText"]>>;
  readonly runId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly outputIntent: "intermediate" | "final";
  readonly normalizer: TranscriptPartNormalizer;
}): LLMTextResponse {
  const { result } = input;
  const toolCalls = result.toolCalls?.map((toolCall) => ({
    id: normalizeProviderToolCallId(toolCall.toolCallId) ?? crypto.randomUUID(),
    toolName: toolCall.toolName,
    args: normalizeToolArgs(toolCall.args),
  }));
  return {
    parts: input.normalizer.normalize({
      runId: input.runId,
      turnId: input.turnId,
      providerId: input.providerId,
      providerParts: result.transcriptParts,
      providerText: result.text,
      toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
      outputIntent: input.outputIntent,
    }),
    usage: result.usage,
    finishReason: result.finishReason,
    toolCalls,
    reasoningSummary: extractSafeReasoningSummary(result.transcriptParts),
  };
}

function extractSafeReasoningSummary(
  parts: readonly ProviderTranscriptPart[] | undefined,
): LLMTextResponse["reasoningSummary"] {
  const summary = parts
    ?.find(
      (part) =>
        part.type === "reasoning" &&
        part.displaySafe === true &&
        part.text?.trim(),
    )
    ?.text?.trim();
  if (!summary) return undefined;
  return { text: summary, displaySafe: true };
}

function normalizeProviderToolCallId(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return {};
  return args as Record<string, unknown>;
}
