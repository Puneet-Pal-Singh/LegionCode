import type { RunId } from "@repo/platform-protocol";

export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 30_000;

export interface GitCommandExecutionInput {
  readonly runId: RunId;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface GitCommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandExecutor {
  execute(
    input: GitCommandExecutionInput,
  ): Promise<GitCommandExecutionResult>;
}
