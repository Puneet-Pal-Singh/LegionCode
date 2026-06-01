import { DEFAULT_RUN_MODE } from "@repo/shared-types";
import type { OrchestratorBackend } from "@shadowbox/orchestrator-core";
import { RunManifestMismatchError } from "@shadowbox/orchestrator-core";
import type {
  RunInput,
  RunManifest,
  RuntimeAuthMode,
  RuntimeExecutionBackend,
  RuntimeHarnessId,
  RuntimeHarnessMode,
} from "../types.js";

export { RunManifestMismatchError } from "@shadowbox/orchestrator-core";

/**
 * Creates a run manifest with deterministic configuration.
 *
 * Selection fields follow explicit precedence:
 * 1. Use request-supplied selection when provided
 * 2. Otherwise apply deterministic defaults
 *
 * This ensures portable, explicit backend selection without implicit fallbacks.
 */
export function createRunManifest(input: RunInput): RunManifest {
  const orchestratorBackend = normalizeOrchestratorBackend(
    input.orchestratorBackend,
  );

  return {
    mode: input.mode ?? DEFAULT_RUN_MODE,
    providerId: normalizeOptionalSelection(input.providerId),
    modelId: normalizeOptionalSelection(input.modelId),
    runtimeModelId: normalizeOptionalSelection(input.runtimeModelId),
    providerTransport: input.providerTransport ?? null,
    providerEndpoint: normalizeOptionalSelection(input.providerEndpoint),
    harness: normalizeHarnessSelection(input.harnessId),
    orchestratorBackend,
    executionBackend: normalizeExecutionBackend(input.executionBackend),
    harnessMode: normalizeHarnessMode(input.harnessMode, input.metadata),
    authMode: normalizeAuthMode(input.authMode),
  };
}

export function ensureManifestMatch(
  existing: RunManifest | undefined,
  candidate: RunManifest,
): void {
  if (!existing) {
    return;
  }
  if (
    existing.mode !== candidate.mode ||
    existing.providerId !== candidate.providerId ||
    existing.modelId !== candidate.modelId ||
    existing.runtimeModelId !== candidate.runtimeModelId ||
    existing.providerTransport !== candidate.providerTransport ||
    existing.providerEndpoint !== candidate.providerEndpoint ||
    existing.harness !== candidate.harness ||
    existing.orchestratorBackend !== candidate.orchestratorBackend ||
    existing.executionBackend !== candidate.executionBackend ||
    existing.harnessMode !== candidate.harnessMode ||
    existing.authMode !== candidate.authMode
  ) {
    throw new RunManifestMismatchError(existing, candidate);
  }
}

function normalizeOptionalSelection(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeHarnessSelection(
  harnessId?: RuntimeHarnessId,
): RuntimeHarnessId {
  return harnessId ?? "cloudflare-sandbox";
}

function normalizeOrchestratorBackend(
  orchestratorBackend?: OrchestratorBackend,
): OrchestratorBackend {
  return orchestratorBackend ?? "execution-engine-v1";
}

function normalizeExecutionBackend(
  executionBackend?: RuntimeExecutionBackend,
): RuntimeExecutionBackend {
  return executionBackend ?? "cloudflare_sandbox";
}

function normalizeHarnessMode(
  harnessMode?: RuntimeHarnessMode,
  metadata?: Record<string, unknown>,
): RuntimeHarnessMode {
  const normalized = harnessMode ?? "platform_owned";
  if (normalized !== "delegated") {
    return normalized;
  }

  if (isDelegatedHarnessModeTrusted(metadata)) {
    return "delegated";
  }

  console.warn(
    "[run/manifest] Denied delegated harnessMode without internal authorization; forcing platform_owned.",
  );
  return "platform_owned";
}

function normalizeAuthMode(authMode?: RuntimeAuthMode): RuntimeAuthMode {
  return authMode ?? "api_key";
}

function isDelegatedHarnessModeTrusted(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) {
    return false;
  }

  const internal = metadata.internal;
  if (typeof internal !== "object" || internal === null) {
    return false;
  }

  return (
    (internal as Record<string, unknown>).allowDelegatedHarnessMode === true
  );
}
