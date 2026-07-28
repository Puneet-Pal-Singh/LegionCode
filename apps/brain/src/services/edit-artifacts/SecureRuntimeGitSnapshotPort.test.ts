import { describe, expect, it, vi } from "vitest";
import type { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { SecureRuntimeGitSnapshotPort } from "./SecureRuntimeGitSnapshotPort";

describe("SecureRuntimeGitSnapshotPort", () => {
  it("captures immutable trees and settles changed files against the start tree", async () => {
    const client = {
      captureWorktreeSnapshot: vi
        .fn()
        .mockResolvedValueOnce("a".repeat(40))
        .mockResolvedValueOnce("b".repeat(40)),
      diffWorktreeSnapshots: vi.fn().mockResolvedValue({
        files: [
          {
            path: "src/Footer.tsx",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        patch: "diff --git a/src/Footer.tsx b/src/Footer.tsx",
      }),
    } as unknown as SecureGitArtifactClient;
    const port = new SecureRuntimeGitSnapshotPort(client);
    const workspace = {
      runId: "run_test" as never,
      filesystemRoot: "/workspace",
    };

    const start = await port.captureSnapshot({
      workspace,
      snapshotKey: "turn-test",
    });
    const terminal = await port.captureSnapshot({
      workspace,
      snapshotKey: "turn-test",
    });
    const diff = await port.getSnapshotDiff({ workspace, start, terminal });

    expect(diff.files).toEqual([
      {
        path: "src/Footer.tsx",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(client.diffWorktreeSnapshots).toHaveBeenCalledWith({
      startTree: "a".repeat(40),
      terminalTree: "b".repeat(40),
    });
  });

  it("propagates secure snapshot diff failures instead of reporting a false empty diff", async () => {
    const client = {
      diffWorktreeSnapshots: vi
        .fn()
        .mockRejectedValue(new Error("secure snapshot diff failed")),
    } as unknown as SecureGitArtifactClient;
    const port = new SecureRuntimeGitSnapshotPort(client);
    const snapshot = {
      runId: "run_test" as never,
      filesystemRoot: "/workspace",
      headSha: "a".repeat(40),
      treeId: "a".repeat(40),
    };

    await expect(
      port.getSnapshotDiff({
        workspace: snapshot,
        start: snapshot,
        terminal: snapshot,
      }),
    ).rejects.toThrow("secure snapshot diff failed");
  });
});
