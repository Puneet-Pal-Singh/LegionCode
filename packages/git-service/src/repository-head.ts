import { RunIdSchema } from "@repo/platform-protocol";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
  type GitCommandExecutionResult,
} from "./executor.js";
import { GitServiceError } from "./errors.js";
import { validateBranchNamePolicy } from "./refs.js";

export async function readUnbornBranch(
  executor: GitCommandExecutor,
  runId: ReturnType<typeof RunIdSchema.parse>,
  cwd: string,
): Promise<string | undefined> {
  const inspect = async (args: readonly string[]) => {
    const result = await executor.execute({
      runId,
      cwd,
      args,
      readOnlyProbe: true,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    assertDeterminateHeadResult(result);
    return result;
  };
  const head = await inspect(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (
    head.exitCode !== 1 ||
    head.stdout.length !== 0 ||
    head.stderr.length !== 0
  )
    return undefined;
  const branch = await inspect(["symbolic-ref", "-q", "HEAD"]);
  if (branch.exitCode !== 0 || branch.stderr.length !== 0) return undefined;
  const reference = branch.stdout.trim();
  if (!reference.startsWith("refs/heads/")) return undefined;
  validateBranchNamePolicy(reference.slice("refs/heads/".length));
  const absent = await inspect(["show-ref", "--verify", "--quiet", reference]);
  return absent.exitCode === 1 &&
    absent.stdout.length === 0 &&
    absent.stderr.length === 0
    ? reference
    : undefined;
}

function assertDeterminateHeadResult(result: GitCommandExecutionResult): void {
  if (result.indexPublication === "indeterminate") {
    throw new GitServiceError(
      "git_commit_indeterminate",
      "Git snapshot outcome is indeterminate",
    );
  }
}
