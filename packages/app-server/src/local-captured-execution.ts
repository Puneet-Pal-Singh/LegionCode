import type { ToolAuthorizationPort } from "@repo/runtime-kernel";
import type { LocalPersistence } from "@repo/event-store/local";
import {
  TurnAdmissionSchema,
  TurnWorkspaceSnapshotSchema,
  type TurnAdmission,
} from "@repo/platform-protocol";
import { LocalGuardedFileWorker } from "@legioncode/execution-engine/runtime/desktop/LocalGuardedFileWorker";
import { LocalSingleExecutableWorker } from "@legioncode/execution-engine/runtime/desktop/LocalSingleExecutableWorker";
import { LocalReadOnlyToolWorker } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyToolWorker";
import { createNativeReadExecutionService } from "@legioncode/execution-engine/runtime/desktop/LocalNativeReadExecutionService";
import {
  NativeFilesystemBridge,
  type NativeFilesystemExecution,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { getCodingCoreToolRegistry } from "@legioncode/execution-engine/runtime/tools/CodingToolRegistry";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import { LocalTurnPreparationFailure } from "@legioncode/execution-engine/runtime/desktop/LocalTurnPreparationFailure";
import type {
  LocalTurnExecutionCapability,
  LocalQuiescentWorker,
} from "@legioncode/execution-engine/runtime/desktop/LocalTurnExecutionCapability";
import { createLocalArtifactCapture } from "./local-artifact-capture.js";
import type { createCaptureGitService } from "./local-capture-git.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import type {
  LocalWorkspaceWriterLease,
  LocalWorkspaceWriterLeaseOwner,
} from "./local-workspace-writer-lease.js";
import { LocalWorkspaceWriterLeaseError } from "./local-workspace-writer-lease.js";

const AVAILABLE_TOOL_IDS = [
  "read_file",
  "write_file",
  "edit_file",
  "run_executable",
] as const;
const BACKEND_CAPABILITIES = [
  "filesystem_read",
  "filesystem_write",
  "approval",
  "single_executable_nofork",
] as const;

export interface LocalCapturedExecutionOptions {
  readonly persistence: Pick<
    LocalPersistence,
    "turnArtifacts" | "lifecycleEvents"
  >;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
  readonly storageDirectory: string;
  readonly filesystemHelperPath: string;
  readonly processHelperPath: string;
  /** Real Git owner, using this lease's settlement authority and physical tracking.
   * The read-only Mac readiness adapter is insufficient for private-index capture.
   */
  readonly createCaptureGitService: (
    lease: LocalWorkspaceWriterLease,
    binding: LocalWorkspaceExecutionBinding,
  ) => ReturnType<typeof createCaptureGitService>;
}

/** Explicit captured consumer; the kernel still owns the only baseline and lifecycle. */
export function createLocalCapturedExecutionCapability(
  options: LocalCapturedExecutionOptions,
): Extract<
  LocalTurnExecutionCapability<LocalWorkspaceExecutionBinding>,
  { artifactCapture: "required" }
> {
  return {
    artifactCapture: "required",
    async createExecutionPorts(
      input: TurnAdmission,
      binding: LocalWorkspaceExecutionBinding,
      signal: AbortSignal,
      toolAuthorization: ToolAuthorizationPort,
    ) {
      if (!toolAuthorization?.authorize) {
        throw new Error("Captured file execution requires the canonical tool authorizer");
      }
      const admission = TurnAdmissionSchema.parse(input);
      const attempt: LocalTurnAttemptIdentity = Object.freeze({
        workspaceId: admission.run.workspaceId,
        threadId: admission.run.threadId,
        runId: admission.run.id,
        turnId: admission.turn.id,
        runAttemptId: admission.runAttemptId,
      });
      if (
        admission.run.mode !== "auto_edit" ||
        admission.run.executionCapability !== "repository"
      ) {
        throw new Error(
          "Captured ports require a canonical mutating repository admission",
        );
      }
      signal.throwIfAborted();
      binding.assertCurrent();
      const lease = await options.leases
        .acquire({ binding, attempt })
        .catch((error: unknown) => {
          if (
            error instanceof LocalWorkspaceWriterLeaseError &&
            error.awaitAcquisitionQuiescence
          ) {
            const proof = error.awaitAcquisitionQuiescence;
            throw new LocalTurnPreparationFailure(
              {
                attempt,
                awaitQuiescence: ({ turnId }) =>
                  turnId === attempt.turnId
                    ? proof(attempt)
                    : Promise.resolve(false),
              },
              error,
            );
          }
          throw error;
        });
      try {
        signal.throwIfAborted();
        const scope = { userId: admission.run.userId, ...attempt };
        const artifacts = options.persistence.turnArtifacts.forAttempt(scope);
        const activeSignal = AbortSignal.any([
          signal,
          binding.signal,
          lease.signal,
        ]);
        const assertActive = async () => {
          activeSignal.throwIfAborted();
          binding.assertCurrent();
          await lease.assertCurrent();
          activeSignal.throwIfAborted();
        };
        const readStartReceipt = async () => {
          const saved = await artifacts.getSnapshot("start");
          if (!saved)
            throw new Error("Canonical start snapshot has not been persisted");
          const snapshot = TurnWorkspaceSnapshotSchema.parse(saved.snapshot);
          const artifact = saved.artifact;
          if (
            snapshot.phase !== "start" ||
            snapshot.turnId !== attempt.turnId ||
            snapshot.snapshotKey !== attempt.turnId ||
            snapshot.resumeUnavailableReason !== undefined ||
            artifact.kind !== "workspace_snapshot" ||
            artifact.workspaceId !== scope.workspaceId ||
            artifact.threadId !== scope.threadId ||
            artifact.runId !== scope.runId ||
            artifact.metadata.turnId !== scope.turnId ||
            artifact.metadata.runAttemptId !== scope.runAttemptId ||
            artifact.metadata.role !== "start" ||
            artifact.payloadRef.backend !== "local_blob" ||
            typeof artifact.payloadRef.sha256 !== "string"
          ) {
            throw new Error(
              "Saved baseline receipt does not match this exact captured attempt",
            );
          }
          return { snapshot, artifact };
        };
        const assertMutationReady = async (
          identity: LocalTurnAttemptIdentity,
        ) => {
          for (const key of Object.keys(attempt) as Array<
            keyof LocalTurnAttemptIdentity
          >) {
            if (
              identity[key] !== attempt[key] ||
              lease.attempt[key] !== attempt[key]
            ) {
              throw new Error(
                "Mutation baseline belongs to a different exact attempt",
              );
            }
          }
          await assertActive();
          // RuntimeKernel.begin() already captured and persisted this same start
          // receipt before provider/tools. Never acquire a second baseline here.
          const before = await readStartReceipt();
          await assertActive();
          const after = await readStartReceipt();
          if (
            before.artifact.artifactId !== after.artifact.artifactId ||
            before.artifact.payloadRef.objectKey !==
              after.artifact.payloadRef.objectKey ||
            before.artifact.payloadRef.sha256 !==
              after.artifact.payloadRef.sha256 ||
            JSON.stringify(before.snapshot) !== JSON.stringify(after.snapshot)
          ) {
            throw new Error(
              "Canonical start snapshot changed during mutation authorization",
            );
          }
          await assertActive();
        };
        const filesystem = new NativeFilesystemBridge({
          helperPath: options.filesystemHelperPath,
          rootDirectory: lease.rootDirectory,
          writerLease: lease.writerLease,
          observeExecution: (execution: NativeFilesystemExecution) =>
            lease.trackFilesystem(execution),
        });
        const workerBinding = {
          workspace: binding.workspace,
          filesystemRoot: binding.filesystemRoot,
          rootDirectory: lease.rootDirectory,
          writerLease: lease.writerLease,
          signal: activeSignal,
          assertCurrent: assertActive,
        };
        const reader = new LocalReadOnlyToolWorker(
          createNativeReadExecutionService({
            attempt,
            binding: workerBinding,
            readFile: filesystem.readFile.bind(filesystem),
          }),
          attempt.threadId,
        );
        const files = new LocalGuardedFileWorker({
          admission,
          binding: workerBinding,
          helperPath: options.filesystemHelperPath,
          toolAuthorization,
          lifecycleEvents: options.persistence.lifecycleEvents,
          assertMutationReady,
          observeExecution: (execution: NativeFilesystemExecution) =>
            lease.trackFilesystem(execution),
        });
        const executable = new LocalSingleExecutableWorker({
          admission,
          lease,
          processHelperPath: options.processHelperPath,
          lifecycleEvents: options.persistence.lifecycleEvents,
          assertMutationReady,
        });
        const worker: LocalQuiescentWorker = {
          // The existing executor's tracked wrapper forwards provider results;
          // these adapters never add a second tracker or lifecycle producer.
          executeTool(
            tool: Parameters<LocalQuiescentWorker["executeTool"]>[0],
          ) {
            switch (tool.toolCall.toolName) {
              case "read_file":
                return reader.executeTool(tool);
              case "write_file":
              case "edit_file":
                return files.executeTool(tool);
              case "run_executable":
                return executable.executeTool(tool);
              default:
                return Promise.reject(
                  new Error("Tool is outside the captured backend"),
                );
            }
          },
          async awaitQuiescence(
            request: Parameters<LocalQuiescentWorker["awaitQuiescence"]>[0],
          ) {
            if (request.turnId !== attempt.turnId) return false;
            const results = await Promise.all([
              reader.awaitQuiescence(request),
              files.awaitQuiescence(request),
              executable.awaitQuiescence(request),
            ]);
            return results.every(Boolean);
          },
        };
        const git = await options.createCaptureGitService(lease, binding);
        await assertActive();
        const gitSnapshots = createLocalArtifactCapture({
          binding,
          lease,
          storageDirectory: options.storageDirectory,
          scope,
          git,
        });
        const registry = getCodingCoreToolRegistry(BACKEND_CAPABILITIES);
        const tools = Object.fromEntries(
          AVAILABLE_TOOL_IDS.map((id) => {
            const tool = registry[id];
            if (!tool)
              throw new Error(
                "Canonical captured tool definition is unavailable",
              );
            return [id, tool];
          }),
        );
        return {
          worker,
          gitSnapshots,
          turnArtifacts: artifacts,
          mutationLease: lease,
          availableToolIds: AVAILABLE_TOOL_IDS,
          backendCapabilities: BACKEND_CAPABILITIES,
          tools,
        };
      } catch (error) {
        // Construction may have started a physical helper before rejecting.
        // Keep the original owner/pins and prohibit both new work and settlement.
        lease.markUnknown();
        throw error;
      }
    },
  };
}
