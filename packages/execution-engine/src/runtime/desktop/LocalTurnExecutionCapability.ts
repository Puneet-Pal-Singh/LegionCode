import type { CoreTool } from "ai";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type {
  RuntimeGitSnapshotPort,
  RuntimeTurnArtifactPort,
  WorkerProtocolPort,
  ToolAuthorizationPort,
} from "@repo/runtime-kernel";
import type { ToolBackendCapability } from "../tools/CodingToolRegistry.js";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";

/** Consumer port of the host's exclusive mutation lease, never a second lease owner. */
export interface LocalMutationLease {
  readonly attempt: LocalTurnAttemptIdentity;
  readonly signal: AbortSignal;
  /** Active grant generation and writer fence; used only to authorize new tools. */
  assertCurrent(): void | Promise<void>;
  /** Retained same-attempt writer fence and held root, valid through settlement after revoke.
   * Must reject after release or authority loss; must not consult the revoked UI grant.
   * This does not authorize tool execution or acquire another lease.
   */
  assertSettlementCurrent(): void | Promise<void>;
}

export type LocalQuiescentWorker = WorkerProtocolPort &
  Required<Pick<WorkerProtocolPort, "awaitQuiescence">>;

export interface LocalCapturedExecutionPorts {
  readonly worker: LocalQuiescentWorker;
  readonly gitSnapshots: RuntimeGitSnapshotPort;
  readonly turnArtifacts: RuntimeTurnArtifactPort;
  readonly mutationLease: LocalMutationLease;
  readonly availableToolIds: readonly string[];
  readonly backendCapabilities: readonly ToolBackendCapability[];
  /** Canonical registry-produced definitions after backend capability filtering. */
  readonly tools: Readonly<Record<string, CoreTool>>;
}

export type LocalTurnExecutionCapability<
  TBinding extends LocalReadOnlyWorkspaceBinding,
> =
  | { readonly artifactCapture: "omitted_read_only" }
  | {
      readonly artifactCapture: "required";
      readonly createExecutionPorts: (
        admission: TurnAdmission,
        binding: TBinding,
        signal: AbortSignal,
        /** Same immutable per-attempt policy owner also supplied to RuntimeKernel. */
        toolAuthorization: ToolAuthorizationPort,
      ) => Promise<LocalCapturedExecutionPorts>;
    };
