import { RunIdSchema } from "@repo/platform-protocol";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
  type GitCommandExecutionResult,
} from "./executor.js";
import { GitServiceError } from "./errors.js";
import { validateBranchNamePolicy } from "./refs.js";
import type { GitRepositoryHead, GitStatusInput } from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

/** Named HEAD evidence from the existing contained Git executor. Repeating the
 * observations rejects observed changes; it is not an atomic metadata snapshot.
 */
export async function readGitRepositoryHead(
  executor: GitCommandExecutor,
  input: GitStatusInput,
): Promise<GitRepositoryHead> {
  const runId = RunIdSchema.parse(input.runId);
  const cwd = validateWorkspaceRoot(input.workspaceRoot);
  const inspect = async (args: readonly string[]) => {
    const result = await executor.execute({
      runId, cwd, args, readOnlyProbe: true,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    assertDeterminateHeadResult(result);
    return result;
  };
  const read = async (): Promise<GitRepositoryHead> => {
    const format = await inspect(["rev-parse", "--show-object-format"]);
    const objectFormat = format.stdout.trim();
    if (format.exitCode !== 0 || format.stderr.length !== 0 ||
      (objectFormat !== "sha1" && objectFormat !== "sha256")) throw unavailable();
    const width = objectFormat === "sha1" ? 40 : 64;
    const head = await inspect(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.exitCode === 0) {
      const headSha = head.stdout.trim();
      if (head.stderr.length !== 0 || headSha.length !== width ||
        !/^[a-f0-9]+$/u.test(headSha) || /^0+$/u.test(headSha)) throw unavailable();
      const branch = await inspect(["symbolic-ref", "-q", "HEAD"]);
      if (branch.exitCode !== 0 || branch.stderr.length !== 0) throw unavailable();
      const branchRef = branch.stdout.trim();
      if (!branchRef.startsWith("refs/heads/")) throw unavailable();
      validateBranchNamePolicy(branchRef.slice("refs/heads/".length));
      const commit = await inspect(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (commit.exitCode !== 0 || commit.stderr.length !== 0 || commit.stdout.trim() !== headSha) throw unavailable();
      return { kind: "born", objectFormat, branchRef, headSha };
    }
    const branchRef = await readUnbornBranch(executor, runId, cwd);
    if (!branchRef) throw unavailable();
    // Explicit absent-HEAD guard, never a fabricated commit or baseline tree.
    return { kind: "unborn", objectFormat, branchRef, headSha: "0".repeat(width) };
  };
  const first = await read();
  const current = await read();
  if (first.kind !== current.kind || first.objectFormat !== current.objectFormat ||
    first.branchRef !== current.branchRef || first.headSha !== current.headSha) {
    throw new GitServiceError("git_command_failed", "Repository HEAD changed during inspection");
  }
  return current;
}

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
    throw new GitServiceError("git_commit_indeterminate", "Repository HEAD inspection is indeterminate");
  }
}
function unavailable(): GitServiceError {
  return new GitServiceError("git_command_failed", "Repository HEAD is not a supported stable named branch");
}
