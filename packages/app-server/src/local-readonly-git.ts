import { DefaultGitService } from "@repo/git-service";
import { createGitCommandFailedError, GitServiceError } from "@repo/git-service/errors";
import type { GitCommandExecutor } from "@repo/git-service/executor";
import {
  createVerifiedMacGitExecution,
  type VerifiedMacGitOptions,
} from "./local-mac-git-execution.js";
import { createNodeGitExecutor } from "./local-node-git-executor.js";

/** Read-only Git algorithms through the existing held-root lender and guardian. */
export async function createLocalReadOnlyGitService(
  options: VerifiedMacGitOptions & { turnSignal?: AbortSignal },
): Promise<Pick<DefaultGitService,
  "probeRepository" | "getStatus" | "readRepositoryHead" |
  "getDiff" | "getFileLineCounts" | "getUntrackedFileDiff"
>> {
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
    async execute(input) {
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
      const isDiff = input.args[0] === "diff";
      const pathspecAt = input.args.indexOf("--");
      const commandOptions = pathspecAt < 0 ? input.args : input.args.slice(0, pathspecAt);
      // Raw local review cannot invoke repository-configured diff helpers.
      // Insert fixed options before any caller-selected pathspec, including a
      // file whose literal name happens to match an option.
      const commandArgs = isDiff
        ? ["diff", "--no-ext-diff", "--no-textconv", ...input.args.slice(1)]
        : input.args;
      // Scope names are literal repository paths, never Git pathspec patterns.
      // Classify the original canonical command before adding this global flag.
      const args = isDiff || input.args[0] === "ls-files"
        ? ["--literal-pathspecs", ...commandArgs] : commandArgs;
      const result = await canonical.execute({ ...input, args, readOnlyProbe: true });
      const expectedDifference = isDiff && commandOptions.includes("--no-index") &&
        result.exitCode === 1 && result.stderr.length === 0;
      if ((isDiff || input.args[0] === "ls-files") && result.exitCode !== 0 && !expectedDifference) {
        // The hosted helpers tolerate missing counts/untracked data. A local
        // contained read failure must not become an empty successful review.
        // The expected no-index exit also requires clean stderr: the contained
        // executor reports truncated output as exit 1 plus a diagnostic.
        throw createGitCommandFailedError(args, result.exitCode, result.stderr || result.stdout);
      }
      return result;
    },
  };
  const git = new DefaultGitService(executor);
  return {
    probeRepository: (input) => git.probeRepository(input),
    getStatus: (input) => git.getStatus(input),
    readRepositoryHead: (input) => git.readRepositoryHead(input),
    getDiff: (input) => git.getDiff(input),
    getFileLineCounts: (input) => git.getFileLineCounts(input),
    getUntrackedFileDiff: (input) => git.getUntrackedFileDiff(input),
  };
}
