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
const WORKSPACE = {
  runId: RUN_ID,
  filesystemRoot: "/workspace/run_abcdef",
};
const BRANCH_WORKSPACE = {
  ...WORKSPACE,
  workingBranch: "feat/canonical-git",
};

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

  it("runs canonical diff with optional staged mode and explicit paths", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "diff --git a/src/app.ts b/src/app.ts\n",
      stderr: "",
    });
    const service = new DefaultGitService(executor);

    const result = await service.getDiff({
      workspace: WORKSPACE,
      paths: ["src/app.ts"],
      staged: true,
    });

    expect(result.patch).toBe("diff --git a/src/app.ts b/src/app.ts\n");
    expect(executor.calls[0]).toMatchObject({
      runId: RUN_ID,
      cwd: WORKSPACE.filesystemRoot,
      args: [
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=999999",
        "--cached",
        "--",
        "src/app.ts",
      ],
    });
  });

  it("requires explicit paths for staging", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const service = new DefaultGitService(executor);

    await expect(
      service.stageFiles({
        workspace: WORKSPACE,
        paths: [],
      }),
    ).rejects.toMatchObject({
      code: "invalid_git_input",
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("unstages only explicit paths through the canonical service", async () => {
    const executor = new QueueGitExecutor([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "# branch.head main\0", stderr: "" },
    ]);
    const service = new DefaultGitService(executor);

    await service.unstageFiles({
      workspace: WORKSPACE,
      paths: ["src/app.ts"],
    });

    expect(executor.calls.map((call) => call.args)).toEqual([
      ["reset", "HEAD", "--", "src/app.ts"],
      GIT_STATUS_PORCELAIN_V2_ARGS,
    ]);
  });

  it("stages files before committing with an explicit author", async () => {
    const executor = new QueueGitExecutor([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "# branch.head feat/canonical-git\0", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "[feat abc123] update\n", stderr: "" },
      { exitCode: 0, stdout: "abc123\n", stderr: "" },
      { exitCode: 0, stdout: "feat/canonical-git\n", stderr: "" },
    ]);
    const service = new DefaultGitService(executor);

    const result = await service.commit({
      workspace: WORKSPACE,
      paths: ["src/app.ts"],
      message: "update app",
      author: { name: "Legion", email: "legion@example.com" },
    });

    expect(result).toEqual({
      commitSha: "abc123",
      branchName: "feat/canonical-git",
      committedPaths: ["src/app.ts"],
    });
    expect(executor.calls.map((call) => call.args)).toEqual([
      ["add", "--", "src/app.ts"],
      GIT_STATUS_PORCELAIN_V2_ARGS,
      ["config", "user.name", "Legion"],
      ["config", "user.email", "legion@example.com"],
      ["commit", "-m", "update app"],
      ["rev-parse", "HEAD"],
      ["branch", "--show-current"],
    ]);
  });

  it("pushes HEAD only to the declared working branch", async () => {
    const executor = new QueueGitExecutor([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "abc123\n", stderr: "" },
    ]);
    const service = new DefaultGitService(executor);

    const result = await service.push({
      workspace: BRANCH_WORKSPACE,
      remoteName: "origin",
    });

    expect(result).toEqual({
      remoteName: "origin",
      branchName: "feat/canonical-git",
      headSha: "abc123",
    });
    expect(executor.calls[0]?.args).toEqual([
      "push",
      "-u",
      "origin",
      "HEAD:feat/canonical-git",
    ]);
  });

  it("redacts auth headers from failed push errors", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 128,
      stdout: "",
      stderr: "auth failed",
    });
    const service = new DefaultGitService(executor);

    await expect(
      service.push({
        workspace: BRANCH_WORKSPACE,
        remoteName: "origin",
        authArgs: ["-c", "http.extraheader=AUTHORIZATION: basic secret"],
      }),
    ).rejects.toMatchObject({
      context: {
        args: [
          "-c",
          "http.extraheader=<redacted>",
          "push",
          "-u",
          "origin",
          "HEAD:feat/canonical-git",
        ],
      },
    });
  });

  it("rejects non-canonical push auth args", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const service = new DefaultGitService(executor);

    await expect(
      service.push({
        workspace: BRANCH_WORKSPACE,
        remoteName: "origin",
        authArgs: ["--upload-pack=/tmp/unsafe"],
      }),
    ).rejects.toMatchObject({
      code: "invalid_git_input",
    });
    expect(executor.calls).toHaveLength(0);
  });
});

class QueueGitExecutor implements GitCommandExecutor {
  readonly calls: GitCommandExecutionInput[] = [];

  constructor(private readonly results: GitCommandExecutionResult[]) {}

  async execute(
    input: GitCommandExecutionInput,
  ): Promise<GitCommandExecutionResult> {
    this.calls.push(input);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("Unexpected git command");
    }
    return result;
  }
}
