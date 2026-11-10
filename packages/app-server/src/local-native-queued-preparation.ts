import { isDeepStrictEqual } from "node:util";
import type { LocalPersistence } from "@repo/event-store/local";
import { LocalTurnConfigurationSchema, TurnAdmissionSchema, type TurnAdmission, type TurnId } from "@repo/platform-protocol";
import type { LocalTurnExecutionCapability } from "@legioncode/execution-engine/runtime/desktop/LocalTurnExecutionCapability";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import type { LocalCapturedReservedLease } from "./local-captured-execution.js";
import { verifyLocalNativePredecessorSettlement } from "./local-native-settlement.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLease, type LocalWorkspaceWriterLeaseOwner } from "./local-workspace-writer-lease.js";

type Capability = LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding>;
type Persistence = Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">;
export interface LocalNativeQueuedPreparationInput {
  readonly binding: LocalWorkspaceExecutionBinding;
  readonly admission: TurnAdmission;
  readonly signal: AbortSignal;
}
export interface LocalNativeQueuedPreparation {
  ready(): Promise<{ readonly capability: Capability; readonly predecessorTurnId: TurnId | null }>;
  /** Caller fences/drains its original admission publication before this cleanup.
   * True releases this lease only; the caller still closes the original binding. */
  releaseUnadmitted(): Promise<boolean>;
}

/** Synchronous registration. Only the stored original task may acquire a writer;
 * no terminal event or missing executor is substituted for predecessor proof. */
export function prepareLocalNativeQueuedExecution(options: {
  readonly persistence: Persistence;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
  readonly createCapturedCapability: (reserved: LocalCapturedReservedLease) => Extract<Capability, { artifactCapture: "required" }>;
}, input: LocalNativeQueuedPreparationInput): LocalNativeQueuedPreparation {
  const { binding } = input;
  const { persistence, leases, createCapturedCapability } = options;
  const admission = TurnAdmissionSchema.parse(input.admission);
  if (admission.userMessage.type !== "user_message" || admission.run.executionCapability !== "repository" ||
      admission.run.harnessSelection !== undefined || admission.userMessage.content.harnessSelection !== undefined ||
      binding.workspace.workspaceId !== admission.run.workspaceId) throw unavailable();
  const configuration = LocalTurnConfigurationSchema.parse(admission.userMessage.content.configuration);
  if (admission.run.mode !== (configuration.mode === "build" ? "auto_edit" : "plan")) throw unavailable();
  const attempt: LocalTurnAttemptIdentity = Object.freeze({ workspaceId: admission.run.workspaceId,
    threadId: admission.run.threadId, runId: admission.run.id, turnId: admission.turn.id, runAttemptId: admission.runAttemptId });
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, binding.signal, controller.signal]);
  let lease: LocalWorkspaceWriterLease | undefined;
  let acquisitionInvoked = false;
  let acquisitionError: unknown;
  let fenced = false;
  let cleanup: Promise<boolean> | undefined;
  const acquisition = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    binding.assertCurrent();
    acquisitionInvoked = true;
    try { lease = await leases.acquire({ binding, attempt }); }
    catch (error) { acquisitionError = error; throw error; }
    signal.throwIfAborted();
    binding.assertCurrent();
    const predecessorTurnId = await lease.withPredecessorVerification(async () => {
      signal.throwIfAborted();
      const page = await persistence.turnAdmissions.listByThread({ threadId: admission.run.threadId,
        afterCursor: null, limit: 1, latest: true });
      if (page.admissions.length > 1 || (!page.admissions.length && (page.nextCursor !== null || page.hasEarlier))) throw unavailable();
      const prior = page.admissions[0];
      if (!prior) return null;
      const predecessor = TurnAdmissionSchema.parse(prior);
      if (predecessor.run.userId !== admission.run.userId || predecessor.run.workspaceId !== admission.run.workspaceId ||
          predecessor.run.threadId !== admission.run.threadId || predecessor.turn.id === admission.turn.id) throw unavailable();
      await verifyLocalNativePredecessorSettlement({ persistence, predecessor, successor: admission, lease: lease! });
      signal.throwIfAborted();
      return predecessor.turn.id;
    });
    signal.throwIfAborted();
    binding.assertCurrent();
    const reserved = Object.freeze({ binding, admission, lease });
    const captured = configuration.mode === "build" ? createCapturedCapability(reserved) : undefined;
    const capability: Capability = captured ? {
      artifactCapture: "required",
      createExecutionPorts: (saved, executorBinding, executionSignal, authorization) => {
        if (fenced || !isDeepStrictEqual(TurnAdmissionSchema.parse(saved), admission) || executorBinding !== binding)
          return Promise.reject(unavailable());
        return captured.createExecutionPorts(saved, executorBinding, AbortSignal.any([signal, executionSignal]), authorization);
      },
    } : { artifactCapture: "omitted_read_only" };
    return Object.freeze({ capability: Object.freeze(capability), predecessorTurnId });
  });
  void acquisition.catch(() => undefined);
  return Object.freeze({
    ready: async () => {
      const prepared = await acquisition;
      signal.throwIfAborted();
      return prepared;
    },
    releaseUnadmitted: () => {
      fenced = true;
      controller.abort("Unused queued preparation is closing");
      cleanup ??= Promise.resolve().then(async () => {
        await acquisition.catch(() => undefined);
        if (lease) return lease.releaseUnadmitted(() => persistence.turnAdmissions.getByTurn(admission.turn.id));
        if (!acquisitionInvoked) return true;
        if (acquisitionError instanceof LocalWorkspaceWriterLeaseError && acquisitionError.awaitAcquisitionQuiescence)
          return acquisitionError.awaitAcquisitionQuiescence(attempt);
        return false;
      }).catch(() => false);
      return cleanup;
    },
  });
}

function unavailable(): Error {
  return new Error("Native queued preparation requires exact predecessor resource settlement");
}
