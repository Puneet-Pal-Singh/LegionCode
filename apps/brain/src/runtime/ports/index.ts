/**
 * Runtime ports - Canonical boundary contracts for Brain orchestration.
 *
 * These ports implement the portability boundary architecture from:
 * - Charter 46: Product Architecture Charter
 * - Plan 59: Runtime Decompose/Decouple HLD
 * - PORTABILITY-BOUNDARY-DECOUPLING-PLAN
 */

export type {
  ExecutionSandboxPort,
  ExecutionRuntimePort,
  TaskInput,
  TaskResult,
} from "./ExecutionRuntimePort";
export type { RunOrchestratorPort } from "@shadowbox/orchestrator-core";
export type {
  ProviderAuthPort,
  ModelProviderPort,
  ProviderResolutionPort,
  ModelMetadata,
} from "./ProviderResolutionPort";
export type {
  HarnessId,
  HarnessCapabilities,
  HarnessAdapter,
  HarnessAdapterRegistry,
} from "./HarnessAdapterPort";
