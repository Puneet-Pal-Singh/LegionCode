import {
  DefaultGitService,
  assertGitObjectRetentionProfile,
} from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import {
  executeNativeIndexTransaction,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
} from "@repo/git-service/executor";
import {
  createNativeGitBinding,
  type LocalNativeGitOptions,
} from "./local-native-git.js";
import type { LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

/** Darwin artifact executor using the original held-root metadata callback,
 * writer lease and native private-index transaction. Generic commits still fail
 * the native algorithm's required immutable-source guards. */
export function createArtifactGitExecutor(
  lease: LocalWorkspaceWriterLease,
  options: LocalNativeGitOptions,
): GitCommandExecutor {
  const bind = createNativeGitBinding(options);
  return {
    supportsIndexTransactions: true,
    supportsArtifactIndexGuard: true,
    execute: (input) =>
      lease.withMutationAuthority(
        lease.attempt.workspaceId,
        async (authority) => {
          if (
            input.cwd !== authority.filesystemRoot ||
            (input.runId !== undefined &&
              input.runId !== authority.attempt.runId) ||
            input.environment !== undefined
          )
            throw new GitServiceError(
              "git_process_containment_unavailable",
              "Artifact Git belongs to another authority or index selector",
            );
          const driver = bind(authority);
          if (!input.indexTransaction) return await driver.execute(input);
          const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
          if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > DEFAULT_GIT_COMMAND_TIMEOUT_MS
          )
            throw new GitServiceError(
              "invalid_git_input",
              "Invalid artifact publication deadline",
            );
          const deadline = performance.now() + timeoutMs;
          const remaining = () => {
            const value = Math.ceil(deadline - performance.now());
            if (value < 1)
              throw new GitServiceError(
                "git_command_failed",
                "Artifact publication exceeded its deadline",
              );
            return value;
          };
          let entered = false;
          try {
            await assertGitObjectRetentionProfile(
              {
                execute(request: Parameters<GitCommandExecutor["execute"]>[0]) {
                  if (
                    request.cwd !== input.cwd ||
                    request.runId !== authority.attempt.runId ||
                    request.environment !== undefined ||
                    request.indexTransaction !== undefined ||
                    request.stdin !== undefined
                  )
                    throw new GitServiceError(
                      "invalid_git_input",
                      "Artifact profile belongs to another authority",
                    );
                  return driver.execute({
                    args: request.args,
                    timeoutMs: request.timeoutMs,
                    signal: authority.signal,
                  });
                },
              },
              {
                runId: authority.attempt.runId,
                filesystemRoot: authority.filesystemRoot,
              },
              remaining(),
            );
            const layout = await driver.verifyMutationMetadata();
            remaining();
            await authority.assertCurrent();
            return await driver.filesystem.withPrivateFileTransaction(
              {
                directory: ".git",
                file: "index",
                expectedIdentity: driver.metadataIdentity,
                expectedLayout: layout,
                signal: authority.settlementSignal,
                beforePublish: async () => {
                  await authority.assertSettlementCurrent();
                },
              },
              async (session) => {
                entered = true;
                const result = await executeNativeIndexTransaction(
                  { ...input, timeoutMs: remaining() },
                  {
                    session,
                    get unknown() {
                      return driver.unknown;
                    },
                    assertActive: () => authority.assertCurrent(),
                    execute: (args, indexFile, stdin, timeoutMs, settling) =>
                      driver.execute({
                        args,
                        indexFile,
                        stdin,
                        timeoutMs,
                        signal: settling
                          ? authority.settlementSignal
                          : authority.signal,
                      }),
                  },
                );
                if (result.indexPublication === "indeterminate")
                  authority.markUnknown();
                return result;
              },
            );
          } catch (error) {
            if (entered || driver.unknown) {
              authority.markUnknown();
              throw new GitServiceError(
                "git_commit_indeterminate",
                "Native transaction outcome or cleanup could not be established; do not retry automatically",
              );
            }
            if (error instanceof GitServiceError) throw error;
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                error instanceof Error
                  ? error.message
                  : "Native transaction could not start",
            };
          }
        },
      ),
  };
}

export function createArtifactGitService(
  lease: LocalWorkspaceWriterLease,
  options: LocalNativeGitOptions,
): Pick<
  DefaultGitService,
  "commit" | "readConfigValue" | "probeRepository" | "getStatus"
> {
  return new DefaultGitService(createArtifactGitExecutor(lease, options));
}
