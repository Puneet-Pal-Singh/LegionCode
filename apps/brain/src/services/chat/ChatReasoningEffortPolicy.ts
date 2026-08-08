import type { ChatModelMetadata } from "./ChatModelMetadataResolver";

export function validateChatReasoningEffort(
  requestedEffort: string | undefined,
  modelMetadata: ChatModelMetadata,
): string | null {
  if (
    requestedEffort &&
    modelMetadata.reasoningEfforts &&
    !modelMetadata.reasoningEfforts.includes(requestedEffort)
  ) {
    return `Reasoning effort "${requestedEffort}" is not supported by the selected model.`;
  }
  return null;
}
