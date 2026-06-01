import type { ProviderModelTransport } from "@repo/shared-types";
import { ValidationError } from "../../domain/errors";
import type { SDKModelConfig } from "./SDKModelFactory";
import {
  toOpenAICompatibleBaseURL,
  type ProviderTransportRoute,
} from "./ProviderTransportAdapterFactory";

export function buildProviderTransportRoute(input: {
  providerId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}): ProviderTransportRoute | undefined {
  const hasTransport = Boolean(input.providerTransport);
  const hasEndpoint = Boolean(input.providerEndpoint);
  if (!hasTransport && !hasEndpoint) {
    return undefined;
  }
  if (
    !input.providerId ||
    !input.providerTransport ||
    !input.providerEndpoint
  ) {
    throw new ValidationError(
      "Provider route metadata requires providerId, providerTransport, and providerEndpoint.",
      "INVALID_PROVIDER_SELECTION",
    );
  }
  return {
    providerId: input.providerId,
    transport: input.providerTransport,
    endpoint: input.providerEndpoint,
  };
}

export function resolveStructuredRuntimeProvider(
  runtimeProvider: SDKModelConfig["provider"],
  providerTransport: ProviderModelTransport | undefined,
): SDKModelConfig["provider"] {
  if (!providerTransport) {
    return runtimeProvider;
  }
  if (providerTransport === "openai-chat-completions") {
    return "openai-compatible";
  }
  throw new ValidationError(
    `Structured generation is not wired for provider transport "${providerTransport}".`,
    "UNKNOWN_PROVIDER",
  );
}

export function resolveStructuredBaseURLOverride(
  providerTransport: ProviderModelTransport | undefined,
  providerEndpoint: string | undefined,
): string | undefined {
  if (!providerTransport || providerTransport !== "openai-chat-completions") {
    return undefined;
  }
  if (!providerEndpoint) {
    throw new ValidationError(
      "OpenAI-compatible structured generation requires providerEndpoint.",
      "INVALID_PROVIDER_SELECTION",
    );
  }
  return toOpenAICompatibleBaseURL(providerEndpoint);
}
