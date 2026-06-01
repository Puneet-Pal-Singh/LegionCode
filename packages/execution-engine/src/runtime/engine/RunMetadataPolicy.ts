import type {
  CanonicalRunLifecycleStep,
  RunManifest,
  RunOrchestrationTelemetry,
} from "../types.js";
import type { Run } from "../run/index.js";
import type { TurnModeDecision } from "./RunTurnModePolicy.js";

export class MissingManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingManifestError";
  }
}

export function recordPhaseSelectionSnapshot(
  run: Run,
  phase: "planning" | "execution" | "synthesis",
): void {
  const manifest = run.metadata.manifest;
  if (!manifest) {
    throw new MissingManifestError(
      `[run/engine] Missing run manifest before recording ${phase} phase snapshot`,
    );
  }

  const existingSnapshots = run.metadata.phaseSelectionSnapshots ?? {};
  run.metadata.phaseSelectionSnapshots = {
    ...existingSnapshots,
    [phase]: cloneManifest(manifest),
  };
}

export function isPlatformApprovalOwner(manifest?: RunManifest): boolean {
  if (!manifest) {
    throw new MissingManifestError(
      "[run/engine] Missing run manifest before resolving approval owner",
    );
  }
  return manifest.harnessMode !== "delegated";
}

export function recordLifecycleStep(
  run: Run,
  step: CanonicalRunLifecycleStep,
  detail?: string,
): void {
  const existingSteps = run.metadata.lifecycleSteps ?? [];
  run.metadata.lifecycleSteps = [
    ...existingSteps,
    {
      step,
      recordedAt: new Date().toISOString(),
      detail,
    },
  ];
}

export function recordTurnModeDecision(
  run: Run,
  decision: TurnModeDecision,
): void {
  run.metadata.turnMode = {
    mode: decision.mode,
    source: decision.source,
    rationale: decision.rationale,
    confidence: decision.confidence,
    recordedAt: new Date().toISOString(),
  };
}

export function recordOrchestrationActivation(run: Run): void {
  const telemetry = ensureOrchestrationTelemetry(run);
  const nowIso = new Date().toISOString();
  const resumed = telemetry.wakeupCount > 0;

  run.metadata.orchestrationTelemetry = {
    ...telemetry,
    wakeupCount: telemetry.wakeupCount + 1,
    resumeCount: telemetry.resumeCount + (resumed ? 1 : 0),
    lastWakeupAt: nowIso,
    lastResumedAt: resumed ? nowIso : telemetry.lastResumedAt,
  };
}

export function recordOrchestrationTerminal(run: Run): void {
  const telemetry = ensureOrchestrationTelemetry(run);
  const nowIso = new Date().toISOString();
  run.metadata.orchestrationTelemetry = {
    ...telemetry,
    activeDurationMs:
      telemetry.activeDurationMs +
      getDeltaFromIso(telemetry.lastWakeupAt, nowIso),
    lastTerminalAt: nowIso,
  };
}

function cloneManifest(manifest: RunManifest): RunManifest {
  return {
    mode: manifest.mode,
    providerId: manifest.providerId,
    modelId: manifest.modelId,
    runtimeModelId: manifest.runtimeModelId,
    providerTransport: manifest.providerTransport,
    providerEndpoint: manifest.providerEndpoint,
    harness: manifest.harness,
    orchestratorBackend: manifest.orchestratorBackend,
    executionBackend: manifest.executionBackend,
    harnessMode: manifest.harnessMode,
    authMode: manifest.authMode,
  };
}

function ensureOrchestrationTelemetry(run: Run): RunOrchestrationTelemetry {
  return (
    run.metadata.orchestrationTelemetry ?? {
      activeDurationMs: 0,
      wakeupCount: 0,
      resumeCount: 0,
    }
  );
}

function getDeltaFromIso(startIso: string | undefined, endIso: string): number {
  if (!startIso) {
    return 0;
  }
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}
