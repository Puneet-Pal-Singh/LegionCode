import type { BYOKModelCapability } from "@repo/shared-types";

/** Existing selected-title request budget, shared by the host inference adapters. */
export function resolveThreadTitleProviderOptions(
  requestedMaxOutputTokens: number | undefined,
  capabilities: BYOKModelCapability | undefined,
  knownSupportsReasoning: boolean | undefined,
) {
  const reasoning = capabilities?.supportsReasoning ?? knownSupportsReasoning;
  return {
    maxOutputTokens: reasoning === false ? requestedMaxOutputTokens : 2048,
    ...(capabilities?.reasoningEfforts?.includes("low") ? { reasoningEffort: "low" as const } : {}),
  };
}
