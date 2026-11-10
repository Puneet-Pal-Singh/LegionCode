import type { LocalPersistence } from "@repo/event-store/local";
import type { createArtifactGitService } from "./local-artifact-git.js";
import { LocalGitService, LocalGitOperationError } from "./local-git.js";
import type { LocalTurnArtifactReads } from "./local-turn-artifact-reads.js";
import { LocalTurnArtifactCommitService } from "./local-turn-artifact-commit.js";
import type { LocalWorkspaceService, LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLeaseOwner, type LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

export type LocalArtifactCommitCompositionOptions = {
  readonly persistence: Pick<LocalPersistence, "turnAdmissions" | "workspaceGrants" | "turnArtifacts" | "lifecycleEvents">;
  readonly workspaces: Pick<LocalWorkspaceService, "bindForExecution">;
  readonly reads: LocalTurnArtifactReads;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
  readonly createGitService: (lease: LocalWorkspaceWriterLease, binding: LocalWorkspaceExecutionBinding) => ReturnType<typeof createArtifactGitService>;
};

/** Private host port. HTTP/SDK still expose only the existing commit command. */
export type LocalArtifactCommitComposition = LocalTurnArtifactCommitService & {
  shutdown(): Promise<void>;
};

type CommitResources = {
  readonly options: LocalArtifactCommitCompositionOptions;
  readonly bindings: Set<LocalWorkspaceExecutionBinding>;
  readonly leases: Set<LocalWorkspaceWriterLease>;
  readonly operations: Set<Promise<unknown>>;
};
// Actual physical owners survive a rejected shutdown or a dropped caller facade.
const retainedCommitOwners = new Set<CommitResources>();

/** Canonical Git owns policy; the existing lease proves physical resource closure. */
export function createLocalArtifactCommitComposition(
  options: LocalArtifactCommitCompositionOptions,
): LocalArtifactCommitComposition {
  const retainedBindings = new Set<LocalWorkspaceExecutionBinding>();
  const resources: CommitResources = {
    options, bindings: retainedBindings, leases: new Set(), operations: new Set(),
  };
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const service = new LocalTurnArtifactCommitService({
    reads: options.reads,
    git: {
      commit(command) {
        if (stopping || retainedBindings.size) throw unavailable();
        // Register the ORIGINAL complete operation before its first await. A
        // pre-fence commit remains owned even if its response was disconnected.
        const operation = Promise.resolve().then(() => commitOwned(command));
        resources.operations.add(operation);
        retainedCommitOwners.add(resources);
        const settled = () => {
          resources.operations.delete(operation);
          if (!resources.operations.size && !retainedBindings.size && !resources.leases.size)
            retainedCommitOwners.delete(resources);
        };
        void operation.then(settled, settled);
        return operation;
      },
    },
  });
  return Object.assign(service, {
    shutdown(): Promise<void> {
      stopping = true; // Synchronous fence before waiting for original work.
      shutdownPromise ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...resources.operations]);
        if (resources.operations.size || retainedBindings.size || resources.leases.size) {
          retainedCommitOwners.add(resources);
          throw unavailable();
        }
        retainedCommitOwners.delete(resources);
      });
      return shutdownPromise;
    },
  });

  async function commitOwned(command: Parameters<LocalGitService["commit"]>[0]) {
    if (retainedBindings.size) throw unavailable();
    let source: Awaited<ReturnType<LocalTurnArtifactReads["getTurnDiffArtifact"]>>;
    let binding: LocalWorkspaceExecutionBinding;
    try {
      source = await options.reads.getTurnDiffArtifact({ turnId: command.turnId });
      if (!source || source.artifactId !== command.artifactId ||
          source.admission.run.workspaceId !== command.workspaceId ||
          source.admission.run.threadId !== command.threadId ||
          source.admission.run.id !== command.runId ||
          source.admission.turn.id !== command.turnId ||
          source.admission.runAttemptId !== command.runAttemptId) {
        throw new LocalGitOperationError("identity_mismatch", "Saved commit scope could not be verified");
      }
      binding = await options.workspaces.bindForExecution(command.workspaceId);
    } catch (error) {
      if (error instanceof LocalGitOperationError) throw error;
      throw unavailable(); // No commit or writer acquisition has begun.
    }
    const attempt = {
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      runId: command.runId,
      turnId: command.turnId,
      runAttemptId: command.runAttemptId,
    };
    let lease: LocalWorkspaceWriterLease | undefined;
    let acquisitionQuiescent = false;
    let operationSettled = false;
    try {
      try {
        lease = await options.leases.acquire({ binding, attempt });
        resources.leases.add(lease);
      } catch (error) {
        if (error instanceof LocalWorkspaceWriterLeaseError && error.awaitAcquisitionQuiescence) {
          acquisitionQuiescent = await error.awaitAcquisitionQuiescence(attempt).catch(() => false);
        }
        throw unavailable(); // The canonical Git commit owner was never invoked.
      }
      const git = new LocalGitService({
        workspaceGrants: options.persistence.workspaceGrants,
        getAdmission: (turnId) => options.persistence.turnAdmissions.getByTurn(turnId),
        lifecycleEvents: options.persistence.lifecycleEvents,
        artifactForAttempt: (scope) => options.persistence.turnArtifacts.forAttempt(scope),
        gitService: options.createGitService(lease, binding),
        async withWorkspaceGrant(workspaceId, operation) {
          if (workspaceId !== attempt.workspaceId) throw unavailable();
          binding.assertCurrent();
          return operation(binding);
        },
      });
      return await git.commit(command);
    } finally {
      operationSettled = true;
      // The read owner proved this exact immutable publication terminal.
      // That fact alone never proves the NEW commit children are closed:
      // release() additionally awaits every tracked Git/helper/pipe, checks
      // physical quiescence, and refuses unknown constructor/closure paths.
      let released = acquisitionQuiescent;
      try {
        if (lease) released = await lease.release(async (turnId) =>
          operationSettled && turnId === source.admission.turn.id);
      } catch {
        released = false;
      }
      if (released) {
        try {
          await binding.close();
          if (lease) resources.leases.delete(lease);
        } catch { retainedBindings.add(binding); }
      } else retainedBindings.add(binding);
      // Preserve a real irreversible commit receipt even if resource
      // cleanup is uncertain; the retained authority prevents another write.
    }
  }
}

function unavailable(): LocalGitOperationError {
  return new LocalGitOperationError("workspace_unavailable", "Saved commit resources are unavailable");
}
