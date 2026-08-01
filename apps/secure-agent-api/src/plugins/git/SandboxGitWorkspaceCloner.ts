import type { SafeCommandSpec } from "../security/SafeCommand";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type GitCommandRunner = (spec: SafeCommandSpec) => Promise<CommandResult>;

export interface ClonePinnedWorkspaceInput {
  readonly url: string;
  readonly worktree: string;
  readonly authorizedCommitId: string;
  readonly authEnvironment?: Record<string, string>;
  readonly runId: string;
}

/**
 * Materializes only the server-authorized commit for a task checkout.
 *
 * A full clone fetches unrelated history and can exhaust the secure execution
 * deadline before inference starts. The checkout already carries an immutable
 * authorized commit, so fetching exactly that object is both faster and more
 * faithful to the workspace snapshot contract.
 */
export async function clonePinnedWorkspace(
  input: ClonePinnedWorkspaceInput,
  runGit: GitCommandRunner,
): Promise<CommandResult> {
  const commands: SafeCommandSpec[] = [
    {
      command: "git",
      args: ["-C", input.worktree, "init"],
      runId: input.runId,
    },
    {
      command: "git",
      args: [
        "-C",
        input.worktree,
        "config",
        "remote.origin.url",
        input.url,
      ],
      runId: input.runId,
    },
    {
      command: "git",
      args: [
        "-C",
        input.worktree,
        "fetch",
        "--depth=1",
        "--no-tags",
        "origin",
        input.authorizedCommitId,
      ],
      env: input.authEnvironment,
      runId: input.runId,
    },
    {
      command: "git",
      args: [
        "-C",
        input.worktree,
        "checkout",
        "--detach",
        input.authorizedCommitId,
      ],
      runId: input.runId,
    },
  ];

  let result: CommandResult = {
    exitCode: 1,
    stdout: "",
    stderr: "Pinned workspace clone did not execute.",
  };
  for (const command of commands) {
    result = await runGit(command);
    if (result.exitCode !== 0) {
      return result;
    }
  }
  return result;
}
