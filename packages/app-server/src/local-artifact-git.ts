import { DefaultGitService } from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import {
  executeNativeIndexTransaction,
  type GitCommandExecutor,
} from "@repo/git-service/executor";
import {
  createNativeGitBinding,
  type LocalNativeGitOptions,
} from "./local-native-git.js";
import type { LocalWorkspaceWriterLease } from "./local-workspace-writer-lease.js";

/** Private canonical executor. Capabilities stay absent until metadata namespace
 * authority and the complete production transaction have positive physical proof.
 * The Git service therefore refuses mutation at its normal capability gate. */
export function createArtifactGitExecutor(
  lease: LocalWorkspaceWriterLease,
  options: LocalNativeGitOptions,
): GitCommandExecutor {
  const bind = createNativeGitBinding(options);
  return {
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
          let entered = false;
          try {
            return await driver.filesystem.withPrivateFileTransaction(
              {
                directory: ".git",
                file: "index",
                expectedIdentity: driver.metadataIdentity,
                signal: authority.settlementSignal,
                beforePublish: async () => {
                  await authority.assertSettlementCurrent();
                },
              },
              async (session) => {
                entered = true;
                const result = await executeNativeIndexTransaction(input, {
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
                });
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
): Pick<DefaultGitService, "commit" | "readConfigValue" | "probeRepository"> {
  return new DefaultGitService(createArtifactGitExecutor(lease, options));
}
