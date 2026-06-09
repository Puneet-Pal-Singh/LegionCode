import { RunIdSchema } from "@repo/platform-protocol";

import type { GitCommandExecutor } from "./executor.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "./executor.js";
import { createGitCommandFailedError } from "./errors.js";
import { validateBranchWithGit } from "./refs.js";
import {
  GIT_STATUS_PORCELAIN_V2_ARGS,
  parsePorcelainV2Status,
} from "./status.js";
import type {
  GitBranchValidationInput,
  GitBranchValidationResult,
  GitStatusInput,
  GitStatusResult,
} from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

export class DefaultGitService {
  constructor(private readonly executor: GitCommandExecutor) {}

  async getStatus(input: GitStatusInput): Promise<GitStatusResult> {
    const runId = RunIdSchema.parse(input.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspaceRoot);
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args: GIT_STATUS_PORCELAIN_V2_ARGS,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        GIT_STATUS_PORCELAIN_V2_ARGS,
        result.exitCode,
        result.stderr,
      );
    }

    return parsePorcelainV2Status(result.stdout);
  }

  async validateBranch(
    input: GitBranchValidationInput,
  ): Promise<GitBranchValidationResult> {
    return validateBranchWithGit(this.executor, {
      runId: RunIdSchema.parse(input.runId),
      workspaceRoot: validateWorkspaceRoot(input.workspaceRoot),
      branchName: input.branchName,
    });
  }
}
