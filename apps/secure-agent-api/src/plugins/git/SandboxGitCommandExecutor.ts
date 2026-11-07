import {
  gitCommandRunnerArgs,
  gitCommandRunnerEnvironment,
  gitCommandEnvironment,
  parseGitIndexTransactionResult,
} from "@repo/git-service/executor";
import { GitServiceError } from "@repo/git-service/errors";
import type { Sandbox } from "@cloudflare/sandbox";
import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
  GitCommandExecutor,
} from "@repo/git-service";

import { runSafeCommand } from "../security/SafeCommand";
import type { ToolboxCommandContext } from "../security/ToolboxCommandContext";
import { withToolboxCommandContext } from "../security/ToolboxCommandContext";

export class SandboxGitCommandExecutor implements GitCommandExecutor {
  readonly supportsIndexTransactions = true as const;
  readonly supportsArtifactIndexGuard = true as const;
  constructor(
    private readonly sandbox: Sandbox,
    private readonly toolboxContext: ToolboxCommandContext,
    private readonly operation: string,
  ) {}

  async execute(
    input: GitCommandExecutionInput,
  ): Promise<GitCommandExecutionResult> {
    try {
      gitCommandEnvironment({}, input.environment);
    } catch {
      throw new GitServiceError(
        "invalid_git_input",
        "Unsupported canonical Git environment override",
      );
    }
    try {
      const result = await runSafeCommand(
        this.sandbox,
        withToolboxCommandContext(
          {
            command: "node",
            args: gitCommandRunnerArgs(input),
            env: gitCommandRunnerEnvironment(input),
            cwd: input.cwd,
            runId: input.runId,
            timeoutMs: 0,
            borrowedLease: true,
          },
          this.toolboxContext,
          this.operation,
        ),
        ["node"],
      );
      const decoded = parseGitIndexTransactionResult(result.stdout);
      if (decoded.exitCode === 126)
        throw new GitServiceError(
          "git_process_containment_unavailable",
          decoded.stderr,
        );
      return decoded;
    } catch (error) {
      if (error instanceof GitServiceError) throw error;
      throw new GitServiceError(
        "git_commit_indeterminate",
        "Git execution outcome is unavailable; do not retry automatically",
      );
    }
  }
}
