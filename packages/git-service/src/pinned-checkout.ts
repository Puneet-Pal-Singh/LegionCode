import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
  GitCommandExecutor,
} from "./executor.js";

export interface ClonePinnedWorkspaceInput {
  readonly url: string;
  readonly worktree: string;
  readonly authorizedCommitId: string;
  readonly authEnvironment?: Readonly<Record<string, string>>;
}

/**
 * Materializes only the server-authorized commit for a task checkout.
 *
 * Callers retain URL/commit authorization and execution-context ownership. The
 * supplied executor retains command transport and policy; auth is scoped to the
 * exact-commit fetch, never persisted in the remote URL or passed as arguments.
 */
export async function clonePinnedWorkspace(
  input: ClonePinnedWorkspaceInput,
  executor: GitCommandExecutor,
): Promise<GitCommandExecutionResult> {
  const commands: GitCommandExecutionInput[] = [
    { cwd: input.worktree, args: ["init"] },
    {
      cwd: input.worktree,
      args: ["config", "remote.origin.url", input.url],
    },
    {
      cwd: input.worktree,
      args: [
        "fetch",
        "--depth=1",
        "--no-tags",
        "origin",
        input.authorizedCommitId,
      ],
      environment: input.authEnvironment,
    },
    {
      cwd: input.worktree,
      args: ["checkout", "--detach", input.authorizedCommitId],
    },
  ];

  let result: GitCommandExecutionResult = {
    exitCode: 1,
    stdout: "",
    stderr: "Pinned workspace clone did not execute.",
  };
  for (const command of commands) {
    result = await executor.execute(command);
    if (result.exitCode !== 0) {
      return result;
    }
  }
  return result;
}
