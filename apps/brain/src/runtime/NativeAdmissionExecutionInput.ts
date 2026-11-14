import { parseNativeProviderBindingForAdmission } from "@repo/persistence";
import { normalizeRuntimeModelId, resolveProviderRuntimeRoute } from "@repo/provider-core";
import { DomainError } from "../domain/errors";
import type { NativeProviderCredentialContext } from "../services/providers/NativeProviderCredentialResolver";
import type { ExecuteRunPayload } from "./parsing/ExecuteRunPayloadSchema";

/** Execution uses the admitted selection without changing the original request fingerprint. */
export function resolveNativeAdmissionExecutionInput(
  input: ExecuteRunPayload["input"],
  credentials: NativeProviderCredentialContext,
  correlationId: string,
): ExecuteRunPayload["input"] {
  const admitted = parseNativeProviderBindingForAdmission(credentials.binding, credentials.scope);
  const fixedRoute = resolveProviderRuntimeRoute(admitted.providerId, admitted.modelId);
  const runtimeModelId = fixedRoute?.runtimeModelId ?? normalizeRuntimeModelId(admitted.providerId, admitted.modelId);
  if ((input.providerId !== undefined && input.providerId !== admitted.providerId) ||
      (input.modelId !== undefined && input.modelId !== admitted.modelId) ||
      (input.runtimeModelId !== undefined && normalizeRuntimeModelId(admitted.providerId, input.runtimeModelId) !== runtimeModelId) ||
      (fixedRoute && ((input.providerTransport !== undefined && input.providerTransport !== fixedRoute.providerTransport) ||
        (input.providerEndpoint !== undefined && input.providerEndpoint !== fixedRoute.providerEndpoint)))) {
    throw new DomainError(
      "INVALID_PROVIDER_SELECTION", "Native execution must retain its admitted provider, model, and canonical route.",
      400, false, correlationId,
    );
  }
  // Providers with dynamic discovered routes retain their original profile and
  // existing transport/config validation. Fixed routes also cover omitted defaults.
  return {
    ...input,
    providerId: admitted.providerId,
    modelId: admitted.modelId,
    runtimeModelId,
    ...(fixedRoute ?? {}),
  };
}
