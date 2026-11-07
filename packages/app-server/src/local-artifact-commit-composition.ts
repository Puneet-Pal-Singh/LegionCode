import type { LocalPersistence } from "@repo/event-store/local";
import type { createArtifactGitService } from "./local-artifact-git.js";
import { LocalGitService, LocalGitOperationError } from "./local-git.js";
import type { LocalTurnArtifactReads } from "./local-turn-artifact-reads.js";
import { LocalTurnArtifactCommitService } from "./local-turn-artifact-commit.js";
import type { LocalWorkspaceService, LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLeaseOwner, type LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

/** Composition only. Canonical readers authorize immutable output, LocalGitService
 * owns commit policy, and the existing lease tracks every new native resource.
 */
export function createLocalArtifactCommitComposition(options: {
  readonly persistence: Pick<LocalPersistence, "turnAdmissions" | "workspaceGrants" | "turnArtifacts" | "lifecycleEvents">;
  readonly workspaces: Pick<LocalWorkspaceService, "bindForExecution">;
  readonly reads: LocalTurnArtifactReads;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
  readonly createGitService: (lease: LocalWorkspaceWriterLease, binding: LocalWorkspaceExecutionBinding) => ReturnType<typeof createArtifactGitService>;
}): LocalTurnArtifactCommitService {
  // Strong references only, never a cleanup/acceptance authority. Unknown
  // acquisition or release must retain the borrowed root through host lifetime.
  const retainedBindings = new Set<LocalWorkspaceExecutionBinding>();
  return new LocalTurnArtifactCommitService({
    reads: options.reads,
    git: {
      async commit(command) {
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
          const released = lease
            ? await lease.release(async (turnId) => operationSettled && turnId === source.admission.turn.id)
            : acquisitionQuiescent;
          if (released) {
            try { await binding.close(); }
            catch { retainedBindings.add(binding); }
          } else retainedBindings.add(binding);
          // Preserve a real irreversible commit receipt even if resource
          // cleanup is uncertain; the retained authority prevents another write.
        }
      },
    },
  });
}

function unavailable(): LocalGitOperationError {
  return new LocalGitOperationError("workspace_unavailable", "Saved commit resources are unavailable");
}
