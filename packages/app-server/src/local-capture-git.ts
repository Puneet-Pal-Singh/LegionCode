import {
  DefaultGitService,
  assertGitObjectRetentionProfile,
  retainGitWorkspaceSnapshot,
  type GitSnapshotRetentionInput,
  type GitSnapshotRetentionResult,
} from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
} from "@repo/git-service/executor";
import {
  createNativeGitBinding,
  type LocalNativeGitOptions,
} from "./local-native-git.js";
import type { LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

export type LocalCaptureGitOptions = LocalNativeGitOptions;
const unavailable = (message: string) =>
  new GitServiceError("git_process_containment_unavailable", message);

function remaining(deadline: number): number {
  const timeoutMs = Math.ceil(deadline - performance.now());
  if (timeoutMs < 1) {
    throw new GitServiceError(
      "git_command_failed",
      "Capture Git exceeded its deadline",
    );
  }
  return timeoutMs;
}

/** Canonical snapshots through the original retained physical authority. */
export function createCaptureGitService(
  lease: LocalWorkspaceWriterLease,
  options: LocalCaptureGitOptions,
): Pick<
  DefaultGitService,
  "captureSnapshot" | "getSnapshotDiff" | "probeRepository"
> & {
  retainSnapshot(
    input: Omit<GitSnapshotRetentionInput, "assertStorageReady">,
  ): Promise<GitSnapshotRetentionResult>;
} {
  const binding = createNativeGitBinding(options);
  const executor = (
    driver: ReturnType<typeof binding>,
    snapshot?: { expectedPath: string; privatePath: string },
    deadline = performance.now() + DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  ): GitCommandExecutor => ({
    async execute(input) {
      if (
        input.cwd !== driver.authority.filesystemRoot ||
        (input.runId !== undefined &&
          input.runId !== driver.authority.attempt.runId) ||
        input.indexTransaction !== undefined
      )
        throw unavailable(
          "Capture Git belongs to another retained attempt or transaction",
        );
      let indexFile: string | undefined;
      for (const [key, value] of Object.entries(input.environment ?? {})) {
        if (
          key !== "GIT_INDEX_FILE" ||
          !snapshot ||
          value !== snapshot.expectedPath
        )
          throw unavailable(
            "Capture Git rejected an index or environment selector",
          );
        indexFile = snapshot.privatePath;
      }
      return await driver.execute({
        ...input,
        indexFile,
        timeoutMs: Math.min(
          input.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          remaining(deadline),
        ),
      });
    },
  });
  return {
    captureSnapshot: (input) =>
      lease.withSettlementAuthority(async (authority) => {
        if (
          input.workspace.filesystemRoot !== authority.filesystemRoot ||
          input.workspace.runId !== authority.attempt.runId
        )
          throw unavailable("Snapshot belongs to another retained attempt");
        const driver = binding(authority);
        const deadline = performance.now() + DEFAULT_GIT_COMMAND_TIMEOUT_MS;
        const bridge = driver.filesystem;
        const original = `index.legioncode-${input.snapshotKey}`;
        await authority.assertSettlementCurrent();
        await driver.verifyMutationMetadata();
        await assertGitObjectRetentionProfile(
          executor(driver, undefined, deadline),
          input.workspace,
          remaining(deadline),
        );
        const layout = await driver.verifyMutationMetadata();
        remaining(deadline);
        return await bridge.withPrivateFileTransaction(
          {
            directory: ".git",
            file: original,
            expectedIdentity: driver.metadataIdentity,
            expectedLayout: layout,
            signal: authority.settlementSignal,
            beforePublish: async () => {
              await authority.assertSettlementCurrent();
            },
          },
          async (session) => {
            try {
              const git = new DefaultGitService(
                executor(
                  driver,
                  {
                    expectedPath: `${layout.gitDirectory}/${original}`,
                    privatePath: session.filePath(original),
                  },
                  deadline,
                ),
              );
              const snapshot = await git.captureSnapshot(input);
              // The artifact adapter must retain this tree before publication;
              // neither private indexes nor the user index are artifact storage.
              await session.abort();
              remaining(deadline);
              return snapshot;
            } catch (error) {
              if (!session.finalized) {
                if (driver.unknown) await session.quarantine();
                else await session.abort();
              }
              throw error;
            }
          },
        );
      }),
    retainSnapshot: (input) =>
      lease.withSettlementAuthority(async (authority) => {
        if (
          input.workspace.filesystemRoot !== authority.filesystemRoot ||
          input.workspace.runId !== authority.attempt.runId ||
          input.scope.workspaceId !== authority.attempt.workspaceId ||
          input.scope.threadId !== authority.attempt.threadId ||
          input.scope.runId !== authority.attempt.runId ||
          input.scope.turnId !== authority.attempt.turnId ||
          input.scope.runAttemptId !== authority.attempt.runAttemptId
        ) {
          throw unavailable("Snapshot retention belongs to another attempt");
        }
        const driver = binding(authority);
        return await retainGitWorkspaceSnapshot(executor(driver), {
          ...input,
          assertStorageReady: async () => {
            await driver.verifyMutationMetadata();
          },
        });
      }),
    getSnapshotDiff: (input) =>
      lease.withSettlementAuthority(
        async (authority) =>
          await new DefaultGitService(
            executor(binding(authority)),
          ).getSnapshotDiff(input),
      ),
    probeRepository: (input) =>
      lease.withSettlementAuthority(
        async (authority) =>
          await new DefaultGitService(
            executor(binding(authority)),
          ).probeRepository(input),
      ),
  };
}
