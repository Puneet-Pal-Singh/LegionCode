import {
  gitIndexTransactionArgs,
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
    if (input.indexTransaction) {
      let result;
      try {
        result = await runSafeCommand(
          this.sandbox,
          withToolboxCommandContext(
            {
              command: "node",
              args: gitIndexTransactionArgs(input),
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
        return parseGitIndexTransactionResult(result.stdout);
      } catch {
        throw new GitServiceError(
          "git_commit_indeterminate",
          "Git transaction outcome is unavailable; do not retry automatically",
        );
      }
    }
    if (input.stdin !== undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "SandboxGitCommandExecutor does not support stdin",
      };
    }
    return await runSafeCommand(
      this.sandbox,
      withToolboxCommandContext(
        {
          command: "git",
          args: [...input.args],
          env: input.environment ? { ...input.environment } : undefined,
          cwd: input.cwd,
          runId: input.runId,
          timeoutMs: input.timeoutMs,
        },
        this.toolboxContext,
        this.operation,
      ),
      ["git"],
    );
  }
}
