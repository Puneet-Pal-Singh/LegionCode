import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { GitPlugin } from "./GitPlugin";
import { runSafeCommand } from "./security/SafeCommand";

vi.mock("./security/SafeCommand", () => ({
  runSafeCommand: vi.fn(),
}));

interface SafeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function asSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return overrides as Sandbox;
}

describe("GitPlugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes git_status through canonical porcelain-v2 status parsing", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock.mockImplementation(async (_sandbox, spec) => {
      const args = spec.args ?? [];
      if (spec.command === "mkdir") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("--porcelain=v2")) {
        return {
          exitCode: 0,
          stdout: [
            "# branch.oid 1234567890abcdef1234567890abcdef12345678",
            "# branch.head feat/git-service-status-adapter",
            "# branch.ab +1 -2",
            "1 M. N... 100644 100644 100644 1234567890abcdef1234567890abcdef12345678 abcdef1234567890abcdef1234567890abcdef12 src/app.ts",
            "? src/new.ts",
            "? .shadowbox/edit-artifact.patch",
            "? nested/.shadowbox/edit-artifact.patch",
            "",
          ].join("\0"),
          stderr: "",
        };
      }
      if (args.includes("remote.origin.url")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("user.name") || args.includes("user.email")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("--numstat") && !args.includes("--cached")) {
        return { exitCode: 0, stdout: "3\t1\tsrc/app.ts\n", stderr: "" };
      }
      if (args.includes("--numstat") && args.includes("--cached")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (spec.command === "wc") {
        return {
          exitCode: 0,
          stdout: "4 /home/sandbox/runs/run_git_status_1/src/new.ts\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_status",
      runId: "run_git_status_1",
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output)) as {
      branch: string;
      ahead: number;
      behind: number;
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        isStaged: boolean;
      }>;
    };

    expect(output).toMatchObject({
      branch: "feat/git-service-status-adapter",
      ahead: 1,
      behind: 2,
    });
    expect(output.files).toEqual([
      {
        path: "src/app.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        isStaged: true,
      },
      {
        path: "src/new.ts",
        status: "untracked",
        additions: 4,
        deletions: 0,
        isStaged: false,
      },
    ]);

    const statusCommand = runSafeCommandMock.mock.calls.find(([, spec]) =>
      spec.args?.includes("--porcelain=v2"),
    )?.[1] as { args?: string[]; cwd?: string } | undefined;
    expect(statusCommand?.cwd).toBe("/home/sandbox/runs/run_git_status_1");
    expect(statusCommand?.args).toEqual(
      expect.arrayContaining([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
      ]),
    );
    expect(statusCommand?.args).not.toEqual(
      expect.arrayContaining(["--porcelain", "-b"]),
    );
  });

  it("uses --cached when requesting staged diff content", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-console.log('old')\n+console.log('new')\n",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_diff",
      runId: "run_git_diff_1",
      path: "src/example.ts",
      staged: true,
    });

    expect(result.success).toBe(true);

    const diffCommandSpec = runSafeCommandMock.mock.calls[1]?.[1] as
      | { args?: string[] }
      | undefined;
    expect(diffCommandSpec?.args).toContain("--cached");
    expect(diffCommandSpec?.args).not.toContain("--staged");
  });

  it("materializes untracked file content as a new-file diff", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "src/new.ts\n",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "export const value = 1;\n",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_diff",
      runId: "run_git_diff_untracked",
      path: "src/new.ts",
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output)) as {
      isNewFile: boolean;
      hunks: Array<{
        lines: Array<{
          type: string;
          content: string;
          newLineNumber?: number;
        }>;
      }>;
    };
    expect(output.isNewFile).toBe(true);
    expect(output.hunks[0]?.lines).toEqual([
      {
        type: "added",
        content: "export const value = 1;",
        newLineNumber: 1,
      },
    ]);

    const diffCommandSpec = runSafeCommandMock.mock.calls[1]?.[1] as
      | { args?: string[] }
      | undefined;
    expect(diffCommandSpec?.args).toEqual(
      expect.arrayContaining(["diff", "--", "src/new.ts"]),
    );
  });

  it("fails git_diff when reading an untracked file fails", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "src/new.ts\n",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "read failed",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_diff",
      runId: "run_git_diff_untracked_error",
      path: "src/new.ts",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("read failed");
  });

  it("validates and applies saved edit artifact patches", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    const writeFile = vi.fn(async () => ({ success: true }));
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute({ writeFile } as unknown as Sandbox, {
      action: "git_patch_apply",
      runId: "run_patch_apply_1",
      patch: "diff --git a/src/app.ts b/src/app.ts\n",
    });

    expect(result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining(
        "/home/sandbox/runs/run_patch_apply_1/.shadowbox/edit-artifact-",
      ),
      "diff --git a/src/app.ts b/src/app.ts\n",
    );
    const gitApplyCalls = runSafeCommandMock.mock.calls.filter(([, spec]) =>
      spec.args?.includes("apply"),
    );
    expect(gitApplyCalls).toHaveLength(2);
    expect(gitApplyCalls[0]?.[1].args).toContain("--check");
  });

  it("captures untracked edit artifact patches from NUL-delimited paths", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    const readFile = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        content: "",
      })
      .mockResolvedValueOnce({
        success: true,
        content: "diff --git a/src/new file.ts b/src/new file.ts\n",
      })
      .mockResolvedValueOnce({
        success: true,
        content: "diff --git a/src/other.ts b/src/other.ts\n",
      });
    runSafeCommandMock.mockImplementation(async (_sandbox, spec) => {
      const args = spec.args ?? [];
      if (spec.command === "mkdir" || spec.command === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("status")) {
        return {
          exitCode: 0,
          stdout: [
            "# branch.head main",
            "? src/new file.ts",
            "? src/other.ts",
            "",
          ].join("\0"),
          stderr: "",
        };
      }
      if (args.includes("remote.origin.url")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("user.name") || args.includes("user.email")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("ls-files")) {
        return {
          exitCode: 0,
          stdout: "src/new file.ts\0src/other.ts\0",
          stderr: "",
        };
      }
      if (args.includes("--no-index")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("diff")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args.includes("branch")) {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox({ readFile }), {
      action: "git_patch_capture",
      runId: "run_patch_capture_untracked",
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output)) as {
      patch: string;
      baseCommitSha: string;
      branch: string;
    };
    expect(output.patch).toContain("diff --git a/src/new file.ts");
    expect(output.patch).toContain("diff --git a/src/other.ts");
    expect(output.baseCommitSha).toBe("abc123");
    expect(output.branch).toBe("main");

    const lsFilesCommandSpec = runSafeCommandMock.mock.calls.find(([, spec]) =>
      spec.args?.includes("ls-files"),
    )?.[1] as { args?: string[] } | undefined;
    expect(lsFilesCommandSpec?.args).toEqual(
      expect.arrayContaining(["ls-files", "-z"]),
    );

    const untrackedDiffPaths = runSafeCommandMock.mock.calls
      .filter(([, spec]) => spec.args?.includes("--no-index"))
      .map(([, spec]) => spec.args?.at(-1));
    expect(untrackedDiffPaths).toEqual(["src/new file.ts", "src/other.ts"]);
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("captures tracked edit artifact patches from the sandbox patch file", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    const readFile = vi.fn().mockResolvedValueOnce({
      success: true,
      content: "diff --git a/src/app.ts b/src/app.ts\n",
    });
    runSafeCommandMock.mockImplementation(async (_sandbox, spec) => {
      const args = spec.args ?? [];
      if (spec.command === "mkdir" || spec.command === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("status")) {
        return {
          exitCode: 0,
          stdout: [
            "# branch.head main",
            "1 .M N... 100644 100644 100644 1234567890abcdef1234567890abcdef12345678 abcdef1234567890abcdef1234567890abcdef12 src/app.ts",
            "",
          ].join("\0"),
          stderr: "",
        };
      }
      if (args.includes("remote.origin.url")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("user.name") || args.includes("user.email")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args.includes("ls-files")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("diff")) {
        return { exitCode: 0, stdout: "truncated stdout", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args.includes("branch")) {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox({ readFile }), {
      action: "git_patch_capture",
      runId: "run_patch_capture_tracked",
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output)) as { patch: string };
    expect(output.patch).toBe("diff --git a/src/app.ts b/src/app.ts\n");
    expect(output.patch).not.toContain("truncated stdout");
    const diffCommandSpec = runSafeCommandMock.mock.calls.find(([, spec]) =>
      spec.args?.includes("--find-renames"),
    )?.[1] as { args?: string[] } | undefined;
    expect(
      diffCommandSpec?.args?.some((arg) => arg.startsWith("--output=")),
    ).toBe(true);
  });

  it("hydrates commit identity from GitHub token when local identity is missing", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "not set",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "not set",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "commit ok",
        stderr: "",
      } satisfies SafeCommandResult);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42,
            login: "puneet",
            name: "Puneet Singh",
            email: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              email: "puneet@example.com",
              primary: true,
              verified: true,
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_1",
      message: "fix(runtime): hydrate commit identity from github profile",
      token: "ghp_test",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/emails",
      expect.any(Object),
    );
    expect(result.output).toEqual({
      content: "Changes committed",
      commitIdentity: {
        source: "github_profile",
        verified: true,
      },
    });

    const writeNameArgs = (
      runSafeCommandMock.mock.calls[3]?.[1] as {
        args?: string[];
      }
    ).args;
    const writeEmailArgs = (
      runSafeCommandMock.mock.calls[4]?.[1] as {
        args?: string[];
      }
    ).args;
    expect(writeNameArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Puneet Singh"]),
    );
    expect(writeEmailArgs).toEqual(
      expect.arrayContaining(["config", "user.email", "puneet@example.com"]),
    );
  });

  it("prefers OAuth identity over model-provided commit identity and stale git config", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Random User",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "random@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "commit ok",
        stderr: "",
      } satisfies SafeCommandResult);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42,
            login: "puneet",
            name: "Puneet Singh",
            email: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              email: "puneet@example.com",
              primary: true,
              verified: true,
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_2",
      message: "feat: use oauth identity for commit",
      token: "ghp_test",
      authorName: "Shubh",
      authorEmail: "shubh@example.com",
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: "Changes committed",
      commitIdentity: {
        source: "github_profile",
        verified: true,
      },
    });
    const writeNameArgs = (
      runSafeCommandMock.mock.calls[3]?.[1] as {
        args?: string[];
      }
    ).args;
    const writeEmailArgs = (
      runSafeCommandMock.mock.calls[4]?.[1] as {
        args?: string[];
      }
    ).args;
    expect(writeNameArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Puneet Singh"]),
    );
    expect(writeEmailArgs).toEqual(
      expect.arrayContaining(["config", "user.email", "puneet@example.com"]),
    );
  });

  it("pushes HEAD to the requested remote branch ref", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_push",
      runId: "run_git_push_1",
      remote: "origin",
      branch: "style/redesign-footer",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Changes pushed");
    const pushArgs = (
      runSafeCommandMock.mock.calls[1]?.[1] as {
        args?: string[];
      }
    ).args;
    expect(pushArgs).toEqual(
      expect.arrayContaining([
        "push",
        "-u",
        "origin",
        "HEAD:style/redesign-footer",
      ]),
    );
  });

  it("surfaces commit failure from stdout when stderr is empty", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Puneet Singh",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "puneet@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "nothing to commit",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_fail_1",
      message: "feat: add coming soon indicator",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("nothing to commit");
  });

  it("rolls back user.name when writing user.email fails during identity hydration", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Existing User",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "existing@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "write failed",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_rollback_1",
      message: "fix: test rollback path",
      authorName: "OAuth User",
      authorEmail: "oauth@example.com",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Git commit author could not be written to this workspace before committing.",
    );
    const rollbackArgs = (
      runSafeCommandMock.mock.calls[5]?.[1] as {
        args?: string[];
      }
    ).args;
    expect(rollbackArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Existing User"]),
    );
  });
});
