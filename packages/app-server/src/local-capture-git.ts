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
  readSignal?: AbortSignal,
): Pick<
  DefaultGitService,
  | "captureSnapshot"
  | "getSnapshotDiff"
  | "probeRepository"
  | "getStatus"
  | "getDiff"
> & {
  retainSnapshot(
    input: Omit<GitSnapshotRetentionInput, "assertStorageReady">,
  ): Promise<GitSnapshotRetentionResult>;
} {
  const binding = createNativeGitBinding(options);
  const readBinding = createNativeGitBinding(options, "read_only");
  const withActiveRead = <T>(
    filesystemRoot: string,
    runId: string | undefined,
    read: (git: DefaultGitService) => Promise<T>,
  ): Promise<T> =>
    lease.withMutationAuthority(
      lease.attempt.workspaceId,
      async (authority) => {
        if (
          filesystemRoot !== authority.filesystemRoot ||
          runId !== authority.attempt.runId
        )
          throw unavailable("Git read belongs to another retained attempt");
        const signal = AbortSignal.any([
          authority.signal,
          authority.settlementSignal,
          ...(readSignal ? [readSignal] : []),
        ]);
        const assertActive = async () => {
          signal.throwIfAborted();
          await authority.assertCurrent();
          await authority.assertSettlementCurrent();
          signal.throwIfAborted();
        };
        // Cancellation can reject delivery, but must not revoke the original
        // retained authority that proves process closure and final capture.
        const driver = readBinding(authority);
        await assertActive();
        const result = await read(
          new DefaultGitService({
            async execute(input) {
              if (
                input.cwd !== filesystemRoot ||
                input.runId !== runId ||
                input.environment !== undefined ||
                input.indexTransaction !== undefined
              )
                throw unavailable(
                  "Git read rejected another root, run, index or environment selector",
                );
              await assertActive();
              const result = await driver.execute({ ...input, signal });
              await assertActive();
              if (
                result.exitCode === 0 &&
                input.args[1] === "status" &&
                (!result.stdout || !result.stdout.endsWith("\0"))
              )
                throw new GitServiceError(
                  "malformed_status_output",
                  "Native Git status framing is invalid",
                );
              return result;
            },
          }),
        );
        await assertActive();
        return result;
      },
    );
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
    getStatus: (input) =>
      withActiveRead(input.workspaceRoot, input.runId, async (git) => {
        const result = await git.getStatus(input);
        if (result.branch.oid === null || result.branch.head === null)
          throw new GitServiceError(
            "malformed_status_output",
            "Native Git status omitted its branch identity",
          );
        return result;
      }),
    getDiff: (input) =>
      withActiveRead(
        input.workspace.filesystemRoot,
        input.workspace.runId,
        (git) => git.getDiff(input),
      ),
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
