import type { RunId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";

import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
  GitCommandExecutor,
} from "./executor.js";
import { GIT_STATUS_PORCELAIN_V2_ARGS } from "./status.js";
import { DefaultGitService } from "./GitService.js";

const RUN_ID = "run_abcdef" as RunId;

class FakeGitExecutor implements GitCommandExecutor {
  readonly calls: GitCommandExecutionInput[] = [];

  constructor(private readonly result: GitCommandExecutionResult) {}

  async execute(
    input: GitCommandExecutionInput,
  ): Promise<GitCommandExecutionResult> {
    this.calls.push(input);
    return this.result;
  }
}

describe("DefaultGitService", () => {
  it("runs read-only porcelain-v2 status through the executor", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "# branch.head feat/git-service-core\0? src/new.ts\0",
      stderr: "",
    });
    const service = new DefaultGitService(executor);

    const result = await service.getStatus({
      runId: RUN_ID,
      workspaceRoot: "/workspace/run_abcdef",
    });

    expect(result.branch.head).toBe("feat/git-service-core");
    expect(result.entries[0]).toMatchObject({
      kind: "untracked",
      path: "src/new.ts",
    });
    expect(executor.calls[0]).toMatchObject({
      runId: RUN_ID,
      cwd: "/workspace/run_abcdef",
      args: GIT_STATUS_PORCELAIN_V2_ARGS,
    });
  });

  it("rejects missing workspace roots instead of using a default", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const service = new DefaultGitService(executor);

    await expect(
      service.getStatus({
        runId: RUN_ID,
        workspaceRoot: "",
      }),
    ).rejects.toMatchObject({
      code: "invalid_git_input",
    });
    expect(executor.calls).toHaveLength(0);
  });
});
