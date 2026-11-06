import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  RunIdSchema,
  WorkspaceIdSchema,
  TurnIdSchema,
  RunAttemptIdSchema,
  type LocalWorkspaceGrant,
} from "@repo/platform-protocol";
import type { DefaultGitService } from "@repo/git-service";

/** Uses the runtime owner's execution-grant handle and existing Git snapshot port.
 * Tool quiescence remains the runtime owner's responsibility. */
export function createLocalArtifactCapture(options: {
  binding: {
    readonly workspace: LocalWorkspaceGrant;
    readonly filesystemRoot: string;
    readonly signal: AbortSignal;
    assertCurrent(): void;
  };
  /** Owner proves the same retained root and exact-attempt writer fence.
   * Must remain valid for final capture after tool/grant revocation. */
  assertSettlementCurrent(): void | Promise<void>;
  storageDirectory: string;
  scope: {
    workspaceId: string;
    runId: string;
    turnId: string;
    runAttemptId: string;
  };
  git: Pick<
    DefaultGitService,
    "captureSnapshot" | "getSnapshotDiff" | "probeRepository"
  >;
}) {
  const workspaceId = WorkspaceIdSchema.parse(options.scope.workspaceId);
  const runId = RunIdSchema.parse(options.scope.runId);
  const turnId = TurnIdSchema.parse(options.scope.turnId);
  const runAttemptId = RunAttemptIdSchema.parse(options.scope.runAttemptId);
  const snapshotKey = `local_${createHash("sha256")
    .update(JSON.stringify([workspaceId, runId, turnId, runAttemptId]))
    .digest("hex")}`;
  const storageDirectory = options.storageDirectory;
  if (!isAbsolute(storageDirectory) || storageDirectory.includes("\0")) {
    throw new Error(
      "Local artifact storage requires an absolute private directory",
    );
  }
  const binding = options.binding;
  // Capture is retained settlement work, not authority to start a new tool.
  const assertCaptureCurrent = async () => {
    await options.assertSettlementCurrent();
  };
  const requireWorkspace = async (workspace: {
    runId: string;
    filesystemRoot: string;
  }) => {
    if (workspace.runId !== runId)
      throw new Error("Artifact capture run mismatch");
    await assertCaptureCurrent();
    if (
      binding.workspace.workspaceId !== workspaceId ||
      binding.workspace.readiness !== "ready"
    ) {
      throw new Error(
        "Artifact capture requires the current ready workspace grant",
      );
    }
    const stats = await lstat(binding.filesystemRoot);
    await assertCaptureCurrent();
    const root = await realpath(binding.filesystemRoot);
    await assertCaptureCurrent();
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      root !== binding.filesystemRoot ||
      workspace.filesystemRoot !== root
    ) {
      throw new Error(
        "Artifact capture root must match the granted canonical repository root",
      );
    }
    const privateRoot = await realpath(storageDirectory);
    await assertCaptureCurrent();
    const inside = relative(root, privateRoot);
    if (
      inside === "" ||
      (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
    ) {
      throw new Error(
        "Local persistence must be outside the captured repository",
      );
    }
    const probe = await options.git.probeRepository({ workspaceRoot: root });
    await assertCaptureCurrent();
    if (
      (await realpath(probe.repositoryRoot)) !== root ||
      probe.repositoryIdentity !== binding.workspace.repositoryIdentity
    ) {
      throw new Error(
        "Granted repository identity changed before artifact capture",
      );
    }
    await assertCaptureCurrent();
    return { runId, filesystemRoot: root };
  };
  return {
    async captureSnapshot(
      input: Parameters<DefaultGitService["captureSnapshot"]>[0],
    ) {
      if (input.snapshotKey !== turnId)
        throw new Error("Artifact capture turn mismatch");
      const workspace = await requireWorkspace(input.workspace);
      const snapshot = await options.git.captureSnapshot({
        workspace,
        snapshotKey,
      });
      await requireWorkspace(input.workspace);
      if (
        snapshot.runId !== runId ||
        snapshot.filesystemRoot !== workspace.filesystemRoot
      ) {
        throw new Error("Git snapshot returned a different workspace identity");
      }
      return { ...snapshot, runId };
    },
    async getSnapshotDiff(
      input: Parameters<DefaultGitService["getSnapshotDiff"]>[0],
    ) {
      const workspace = await requireWorkspace(input.workspace);
      const diff = await options.git.getSnapshotDiff({ ...input, workspace });
      await requireWorkspace(input.workspace);
      return diff;
    },
  };
}
