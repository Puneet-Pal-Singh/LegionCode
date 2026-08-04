import type {
  BYOKDiscoveredProviderModel,
  ReasoningEffort,
} from "@repo/shared-types";

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"] as const;
const OPENAI_EFFORTS = [
  "none",
  "minimal",
  ...WIDELY_SUPPORTED_EFFORTS,
  "xhigh",
] as const;
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS] as const;
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"] as const;
const OPENAI_GPT5_PRO_EFFORTS = ["high"] as const;
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"] as const;

const GPT5_FAMILY_PATTERN = /(?:^|\/)gpt-5(?:[.-]|$)/;
const GPT5_VERSION_PATTERN = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/;
const GPT5_PRO_PATTERN = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/;
const GPT5_VERSIONED_PRO_PATTERN = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/;

/**
 * Mirrors OpenCode's provider transform: model variants are derived from the
 * provider/model catalog when an upstream model-list endpoint omits them.
 * Explicit provider-declared efforts are handled before this fallback.
 */
export function enrichProviderReasoningVariants(
  providerId: string,
  model: BYOKDiscoveredProviderModel,
): BYOKDiscoveredProviderModel {
  if (
    model.capabilities?.reasoningEfforts?.length &&
    model.capabilityMetadata?.source !== "static_override"
  ) {
    return model;
  }
  if (model.capabilities?.supportsReasoning === false) {
    return model;
  }

  const efforts = resolveCatalogReasoningEfforts(providerId, model.id);
  if (!efforts) {
    return model;
  }

  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      supportsReasoning: true,
      reasoningEfforts: efforts,
    },
    capabilityMetadata: {
      source: "platform_registry",
      confidence: "declared",
      ...(model.capabilityMetadata?.fetchedAt
        ? { fetchedAt: model.capabilityMetadata.fetchedAt }
        : {}),
    },
  };
}

export function resolveCatalogReasoningEfforts(
  providerId: string,
  modelId: string,
): ReasoningEffort[] | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (providerId === "openai") {
    return resolveOpenAIReasoningEfforts(normalized);
  }
  if (providerId === "openrouter" && isOpenAIModelId(normalized)) {
    return resolveOpenRouterOpenAIReasoningEfforts(normalized);
  }
  return undefined;
}

function resolveOpenAIReasoningEfforts(
  modelId: string,
): ReasoningEffort[] | undefined {
  const normalized = modelId.replace(/^openai\//, "");
  if (GPT5_PRO_PATTERN.test(normalized)) {
    return toEfforts(
      GPT5_VERSIONED_PRO_PATTERN.test(normalized)
        ? OPENAI_GPT5_PRO_2_PLUS_EFFORTS
        : OPENAI_GPT5_PRO_EFFORTS,
    );
  }
  if (GPT5_FAMILY_PATTERN.test(normalized)) {
    const version = gpt5Version(normalized);
    if (version === 1) return toEfforts(OPENAI_GPT5_1_EFFORTS);
    if (version !== undefined && version >= 2) {
      return toEfforts(OPENAI_GPT5_2_PLUS_EFFORTS);
    }
    return toEfforts(["minimal", ...WIDELY_SUPPORTED_EFFORTS]);
  }
  if (/^o[1-9](?:[.-]|$)/.test(normalized)) {
    return toEfforts(WIDELY_SUPPORTED_EFFORTS);
  }
  return undefined;
}

function resolveOpenRouterOpenAIReasoningEfforts(
  modelId: string,
): ReasoningEffort[] | undefined {
  if (!/(?:^|\/)openai\//.test(modelId) && !GPT5_FAMILY_PATTERN.test(modelId)) {
    return undefined;
  }
  if (GPT5_PRO_PATTERN.test(modelId)) {
    return toEfforts(
      GPT5_VERSIONED_PRO_PATTERN.test(modelId)
        ? OPENAI_GPT5_PRO_2_PLUS_EFFORTS
        : OPENAI_GPT5_PRO_EFFORTS,
    );
  }
  if (GPT5_FAMILY_PATTERN.test(modelId)) {
    const version = gpt5Version(modelId);
    if (version === 1) return toEfforts(OPENAI_GPT5_1_EFFORTS);
    if (version !== undefined && version >= 2) {
      return toEfforts(OPENAI_GPT5_2_PLUS_EFFORTS);
    }
    return toEfforts(OPENAI_EFFORTS);
  }
  return /^o[1-9](?:[.-]|$)/.test(modelId)
    ? toEfforts(OPENAI_EFFORTS)
    : undefined;
}

function isOpenAIModelId(modelId: string): boolean {
  return (
    /(?:^|\/)openai\//.test(modelId) ||
    GPT5_FAMILY_PATTERN.test(modelId) ||
    /^o[1-9](?:[.-]|$)/.test(modelId)
  );
}

function gpt5Version(modelId: string): number | undefined {
  const match = GPT5_VERSION_PATTERN.exec(modelId);
  return match?.[1] ? Number(match[1]) : undefined;
}

function toEfforts(efforts: readonly string[]): ReasoningEffort[] {
  return [...efforts];
}
