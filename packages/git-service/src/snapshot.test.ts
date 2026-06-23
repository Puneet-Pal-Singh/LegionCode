import type { RunId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import type {
  GitCommandExecutionInput,
  GitCommandExecutionResult,
  GitCommandExecutor,
} from "./executor.js";
import {
  captureGitWorkspaceSnapshot,
  diffGitWorkspaceSnapshots,
} from "./snapshot.js";

const RUN_ID = "run_snapshot001" as RunId;
const WORKSPACE = {
  runId: RUN_ID,
  filesystemRoot: "/workspace/run_snapshot001",
};
const HEAD = "a".repeat(40);
const START_TREE = "b".repeat(40);
const TERMINAL_TREE = "c".repeat(40);

describe("git workspace snapshots", () => {
  it("captures all workspace files through an isolated index", async () => {
    const executor = new QueueExecutor([
      success("/git/worktrees/run/index.legioncode-turn_snapshot001\n"),
      success(""),
      success(""),
      success(`${START_TREE}\n`),
      success(`${HEAD}\n`),
    ]);

    const snapshot = await captureGitWorkspaceSnapshot(executor, {
      workspace: WORKSPACE,
      snapshotKey: "turn_snapshot001",
    });

    expect(snapshot).toEqual({
      runId: RUN_ID,
      filesystemRoot: WORKSPACE.filesystemRoot,
      headSha: HEAD,
      treeId: START_TREE,
    });
    expect(executor.calls.slice(1, 4).map((call) => call.args)).toEqual([
      ["read-tree", "HEAD"],
      ["add", "-A"],
      ["write-tree"],
    ]);
    expect(executor.calls[2]?.environment).toEqual({
      GIT_INDEX_FILE: "/git/worktrees/run/index.legioncode-turn_snapshot001",
    });
  });

  it("computes an immutable multi-file diff between snapshot trees", async () => {
    const executor = new QueueExecutor([
      success("M\0src/app.ts\0R100\0old.ts\0new.ts\0A\0src/new.ts\0"),
      success(
        [
          "3\t1\tsrc/app.ts",
          "2\t0\t",
          "old.ts",
          "new.ts",
          "5\t0\tsrc/new.ts",
          "",
        ].join("\0"),
      ),
      success("diff --git a/src/app.ts b/src/app.ts\n"),
    ]);
    const diff = await diffGitWorkspaceSnapshots(executor, {
      workspace: WORKSPACE,
      start: snapshot(START_TREE),
      terminal: snapshot(TERMINAL_TREE),
    });

    expect(diff.files).toEqual([
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
      },
      {
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        additions: 2,
        deletions: 0,
      },
      {
        path: "src/new.ts",
        previousPath: null,
        status: "added",
        additions: 5,
        deletions: 0,
      },
    ]);
    expect(diff.patch).toContain("diff --git");
  });

  it("returns an explicit empty diff for identical snapshots", async () => {
    const executor = new QueueExecutor([success(""), success(""), success("")]);
    await expect(
      diffGitWorkspaceSnapshots(executor, {
        workspace: WORKSPACE,
        start: snapshot(START_TREE),
        terminal: snapshot(START_TREE),
      }),
    ).resolves.toEqual({ files: [], patch: "" });
  });
});

class QueueExecutor implements GitCommandExecutor {
  readonly calls: GitCommandExecutionInput[] = [];

  constructor(private readonly results: GitCommandExecutionResult[]) {}

  async execute(
    input: GitCommandExecutionInput,
  ): Promise<GitCommandExecutionResult> {
    this.calls.push(input);
    const result = this.results.shift();
    if (!result) throw new Error("Missing queued Git result");
    return result;
  }
}

function snapshot(treeId: string) {
  return {
    runId: RUN_ID,
    filesystemRoot: WORKSPACE.filesystemRoot,
    headSha: HEAD,
    treeId,
  };
}

function success(stdout: string): GitCommandExecutionResult {
  return { exitCode: 0, stdout, stderr: "" };
}
