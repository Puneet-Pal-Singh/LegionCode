import { DefaultGitService } from "@repo/git-service";
import { GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutor } from "@repo/git-service/executor";
import {
  createVerifiedMacGitExecution,
  type VerifiedMacGitOptions,
} from "./local-mac-git-execution.js";
import { createNodeGitExecutor } from "./local-node-git-executor.js";

/** Read-only Git algorithms through the existing held-root lender and guardian. */
export async function createLocalReadOnlyGitService(
  options: VerifiedMacGitOptions & { turnSignal?: AbortSignal },
): Promise<Pick<DefaultGitService, "probeRepository" | "getStatus">> {
  const turnSignal = options.turnSignal;
  const macExecution = await createVerifiedMacGitExecution({
    ...options,
    purpose: "repo_probe",
    withRootAuthority: (cwd, operation) =>
      options.withRootAuthority(cwd, (authority) =>
        operation({
          ...authority,
          signal: turnSignal
            ? AbortSignal.any([authority.signal, turnSignal])
            : authority.signal,
        }),
      ),
  });
  const canonical = createNodeGitExecutor({ macExecution });
  const executor: GitCommandExecutor = {
    execute(input) {
      if (
        input.indexTransaction !== undefined ||
        Object.keys(input.environment ?? {}).some(
          (key) => key.toUpperCase() === "GIT_INDEX_FILE",
        )
      ) {
        throw new GitServiceError(
          "git_process_containment_unavailable",
          "Read-only Git does not accept private index operations",
        );
      }
      return canonical.execute({ ...input, readOnlyProbe: true });
    },
  };
  const git = new DefaultGitService(executor);
  return {
    probeRepository: (input) => git.probeRepository(input),
    getStatus: (input) => git.getStatus(input),
  };
}
