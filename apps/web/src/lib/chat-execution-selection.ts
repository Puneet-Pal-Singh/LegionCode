import {
  APP_SERVER_PROTOCOL_VERSION,
  ChatRequestBodySchema as CanonicalChatRequestBodySchema,
  type HarnessSelectionResponse,
  type SubmissionAttempt,
} from "@legioncode/sdk";
import type { ReasoningEffort } from "@repo/shared-types";
import type { ResolvedProviderConfig } from "./chat-provider-config";
import { ChatRequestBodySchema, type ChatRequestBody } from "./chat-request";
import { resolveReasoningEffortForRequest } from "./model-reasoning-preferences";

export type CapturedHarnessSelection = NonNullable<
  ChatRequestBody["harnessSelection"]
>;
export type ChatExecutionConfiguration =
  | {
      strategy: "native";
      provider: ResolvedProviderConfig;
      harnessSelection?: CapturedHarnessSelection;
    }
  | { strategy: "delegated"; harnessSelection: CapturedHarnessSelection }
  | { strategy: "frozen"; request: ChatRequestBody };

export function captureHarnessSelection(
  receipt: HarnessSelectionResponse,
): CapturedHarnessSelection {
  return {
    environmentId: receipt.environmentId,
    selectionRevision: receipt.revision,
    selection: receipt.selection,
  };
}

/** An uncertain retry reuses its exact SDK-owned envelope, never current settings. */
export function readFrozenChatRequest(
  attempt: SubmissionAttempt | null,
): ChatRequestBody | null {
  if (!attempt?.wireBody) return null;
  const envelope: unknown = JSON.parse(attempt.wireBody);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !("method" in envelope) ||
    envelope.method !== "turn/submit" ||
    !("protocolVersion" in envelope) ||
    envelope.protocolVersion !== APP_SERVER_PROTOCOL_VERSION ||
    !("params" in envelope)
  )
    throw new Error("Frozen chat submission envelope is invalid.");
  const parsed = CanonicalChatRequestBodySchema.parse(envelope.params);
  const request = { ...parsed };
  Reflect.deleteProperty(request, "messages");
  return ChatRequestBodySchema.parse(request);
}

export function executionRequestFields(
  config: Exclude<ChatExecutionConfiguration, { strategy: "frozen" }>,
  efforts?: readonly ReasoningEffort[],
) {
  if (config.strategy === "delegated")
    return { harnessSelection: config.harnessSelection };
  const reasoningEffort = resolveReasoningEffortForRequest(
    config.provider.providerId,
    config.provider.modelId,
    efforts,
  );
  return {
    ...(config.harnessSelection
      ? { harnessSelection: config.harnessSelection }
      : {}),
    harnessId: "cloudflare-sandbox" as const,
    providerId: config.provider.providerId,
    modelId: config.provider.modelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
