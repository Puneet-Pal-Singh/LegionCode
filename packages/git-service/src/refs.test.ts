import type { RunId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";

import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
  GitCommandExecutor,
} from "./executor.js";
import { GitServiceError } from "./errors.js";
import {
  validateBranchNamePolicy,
  validateBranchWithGit,
  validateRemoteName,
} from "./refs.js";

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

describe("validateBranchNamePolicy", () => {
  it("accepts canonical task branch names", () => {
    expect(validateBranchNamePolicy("feat/git-service-core")).toBe(
      "feat/git-service-core",
    );
  });

  it("rejects reflog, whitespace, and unsafe syntax before git execution", () => {
    for (const branchName of ["@{-1}", "feat/bad branch", "feat/../bad"]) {
      expect(() => validateBranchNamePolicy(branchName)).toThrow(
        GitServiceError,
      );
    }
  });
});

describe("validateRemoteName", () => {
  it("accepts simple remote names and rejects shell-like names", () => {
    expect(validateRemoteName("origin")).toBe("origin");
    expect(validateRemoteName("upstream-1")).toBe("upstream-1");
    expect(() => validateRemoteName("origin/main")).toThrow(GitServiceError);
    expect(() => validateRemoteName("origin;git")).toThrow(GitServiceError);
  });
});

describe("validateBranchWithGit", () => {
  it("delegates branch validation to git check-ref-format", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "feat/git-service-core\n",
      stderr: "",
    });

    const result = await validateBranchWithGit(executor, {
      runId: RUN_ID,
      workspaceRoot: "/workspace/run_abcdef",
      branchName: "feat/git-service-core",
    });

    expect(result).toEqual({
      branchName: "feat/git-service-core",
      checkedRef: "feat/git-service-core",
    });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.args).toEqual([
      "check-ref-format",
      "--branch",
      "feat/git-service-core",
    ]);
  });

  it("does not fall back to main when branch policy rejects a name", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "main\n",
      stderr: "",
    });

    await expect(
      validateBranchWithGit(executor, {
        runId: RUN_ID,
        workspaceRoot: "/workspace/run_abcdef",
        branchName: "@{-1}",
      }),
    ).rejects.toMatchObject({
      code: "invalid_branch_ref",
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects missing workspace roots before git execution", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 0,
      stdout: "feat/git-service-core\n",
      stderr: "",
    });

    await expect(
      validateBranchWithGit(executor, {
        runId: RUN_ID,
        workspaceRoot: "",
        branchName: "feat/git-service-core",
      }),
    ).rejects.toMatchObject({
      code: "invalid_git_input",
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("returns typed invalid-ref errors from git check-ref-format failures", async () => {
    const executor = new FakeGitExecutor({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: invalid branch name",
    });

    await expect(
      validateBranchWithGit(executor, {
        runId: RUN_ID,
        workspaceRoot: "/workspace/run_abcdef",
        branchName: "feat/git-service-core",
      }),
    ).rejects.toMatchObject({
      code: "invalid_branch_ref",
    });
  });
});
