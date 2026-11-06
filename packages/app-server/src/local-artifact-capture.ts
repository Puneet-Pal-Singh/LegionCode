import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { LocalPersistence } from "@repo/event-store/local";
import {
  RunIdSchema,
  WorkspaceIdSchema,
  TurnIdSchema,
  RunAttemptIdSchema,
} from "@repo/platform-protocol";
import type { DefaultGitService } from "@repo/git-service";

/** Grant-scoped adapter for the existing runtime Git snapshot port. Lease and
 * tool quiescence remain the runtime owner's responsibility. */
export function createLocalArtifactCapture(options: {
  workspaceGrants: LocalPersistence["workspaceGrants"];
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
  let grantIdentity: string | null = null;
  const requireWorkspace = async (workspace: {
    runId: string;
    filesystemRoot: string;
  }) => {
    if (workspace.runId !== runId)
      throw new Error("Artifact capture run mismatch");
    const stored = await options.workspaceGrants.read();
    if (
      !stored ||
      stored.grant.workspaceId !== workspaceId ||
      stored.grant.readiness !== "ready"
    ) {
      throw new Error(
        "Artifact capture requires the current ready workspace grant",
      );
    }
    const stats = await lstat(stored.path);
    const root = await realpath(stored.path);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      root !== stored.path ||
      workspace.filesystemRoot !== root
    ) {
      throw new Error(
        "Artifact capture root must match the granted canonical repository root",
      );
    }
    const privateRoot = await realpath(storageDirectory);
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
    if (
      (await realpath(probe.repositoryRoot)) !== root ||
      probe.repositoryIdentity !== stored.grant.repositoryIdentity
    ) {
      throw new Error(
        "Granted repository identity changed before artifact capture",
      );
    }
    const identity = JSON.stringify([
      root,
      stored.grant.grantedAt,
      stored.grant.repositoryIdentity,
      stats.dev,
      stats.ino,
    ]);
    if (grantIdentity !== null && grantIdentity !== identity) {
      throw new Error("Workspace grant changed during this capture attempt");
    }
    grantIdentity = identity;
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
