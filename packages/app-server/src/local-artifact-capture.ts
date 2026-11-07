import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  RunIdSchema,
  WorkspaceIdSchema,
  TurnIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "@repo/platform-protocol";
import type {
  DefaultGitService,
  GitSnapshotRetentionScope,
} from "@repo/git-service";
import type { createCaptureGitService } from "./local-capture-git.js";
import type { LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import type {
  LocalWorkspaceWriterAuthority,
  LocalWorkspaceWriterLease,
} from "./local-workspace-writer-lease.js";

/** Uses the runtime owner's execution-grant handle and existing Git snapshot port.
 * Tool quiescence remains the runtime owner's responsibility. */
export function createLocalArtifactCapture(options: {
  binding: LocalWorkspaceExecutionBinding;
  /** Original attempt's owner; final capture borrows its retained authority. */
  lease: LocalWorkspaceWriterLease;
  storageDirectory: string;
  scope: GitSnapshotRetentionScope;
  /** Must be created with this SAME lease by the held-FD/private-index driver. */
  git: ReturnType<typeof createCaptureGitService>;
}) {
  const userId = UserIdSchema.parse(options.scope.userId);
  const workspaceId = WorkspaceIdSchema.parse(options.scope.workspaceId);
  const threadId = ThreadIdSchema.parse(options.scope.threadId);
  const runId = RunIdSchema.parse(options.scope.runId);
  const turnId = TurnIdSchema.parse(options.scope.turnId);
  const runAttemptId = RunAttemptIdSchema.parse(options.scope.runAttemptId);
  const scope = {
    userId,
    workspaceId,
    threadId,
    runId,
    turnId,
    runAttemptId,
  } satisfies GitSnapshotRetentionScope;
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
  const lease = options.lease;
  let rootIdentity: { dev: bigint; ino: bigint } | undefined;
  // Capture is retained settlement work, not authority to start a new tool.
  const assertCaptureCurrent = async (
    authority: LocalWorkspaceWriterAuthority,
  ) => {
    binding.assertSettlementCurrent();
    await authority.assertSettlementCurrent();
    if (
      authority.rootDirectory !== binding.rootDirectory ||
      authority.writerLease !== lease.writerLease ||
      authority.filesystemRoot !== binding.filesystemRoot ||
      authority.attempt.workspaceId !== workspaceId ||
      authority.attempt.threadId !== threadId ||
      authority.attempt.runId !== runId ||
      authority.attempt.turnId !== turnId ||
      authority.attempt.runAttemptId !== runAttemptId
    ) {
      throw new Error("Artifact capture requires the original attempt's pins");
    }
    const stats = await binding.rootDirectory.stat({ bigint: true });
    binding.assertSettlementCurrent();
    await authority.assertSettlementCurrent();
    if (
      !stats.isDirectory() ||
      (rootIdentity !== undefined &&
        (stats.dev !== rootIdentity.dev || stats.ino !== rootIdentity.ino))
    ) {
      throw new Error("Artifact capture held root changed");
    }
    rootIdentity ??= { dev: stats.dev, ino: stats.ino };
    return stats;
  };
  const requireWorkspace = async (
    workspace: { runId: string; filesystemRoot: string },
    authority: LocalWorkspaceWriterAuthority,
  ) => {
    if (workspace.runId !== runId)
      throw new Error("Artifact capture run mismatch");
    const root = await assertCaptureCurrent(authority);
    if (
      binding.workspace.workspaceId !== workspaceId ||
      binding.workspace.readiness !== "ready"
    ) {
      throw new Error(
        "Artifact capture requires the original ready workspace grant",
      );
    }
    // This path is the immutable snapshot label, never a path to reopen.
    if (workspace.filesystemRoot !== binding.filesystemRoot) {
      throw new Error(
        "Artifact capture root must match the granted canonical repository root",
      );
    }
    // Trusted host storage must stay outside the physical captured root even
    // when that root's old pathname has been renamed or replaced.
    const privateRoot = await realpath(storageDirectory);
    for (let ancestor = privateRoot; ; ancestor = dirname(ancestor)) {
      const stats = await lstat(ancestor, { bigint: true });
      await assertCaptureCurrent(authority);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new Error("Local artifact storage ancestry changed");
      if (stats.dev === root.dev && stats.ino === root.ino) {
        throw new Error(
          "Local persistence must be outside the captured repository",
        );
      }
      if (dirname(ancestor) === ancestor) break;
    }
    const probe = await options.git.probeRepository({
      workspaceRoot: binding.filesystemRoot,
    });
    await assertCaptureCurrent(authority);
    // The held-FD Git driver validates physical metadata identity. A probe's
    // reported pathname may change after rename and is not root authority.
    if (probe.repositoryIdentity !== binding.workspace.repositoryIdentity) {
      throw new Error(
        "Granted repository identity changed before artifact capture",
      );
    }
    return { runId, filesystemRoot: binding.filesystemRoot };
  };
  return {
    async captureSnapshot(
      input: Parameters<DefaultGitService["captureSnapshot"]>[0],
    ) {
      if (input.snapshotKey !== turnId)
        throw new Error("Artifact capture turn mismatch");
      return await lease.withSettlementAuthority(async (authority) => {
        const workspace = await requireWorkspace(input.workspace, authority);
        const snapshot = await options.git.captureSnapshot({
          workspace,
          snapshotKey,
        });
        await requireWorkspace(input.workspace, authority);
        if (
          snapshot.runId !== runId ||
          snapshot.filesystemRoot !== workspace.filesystemRoot
        ) {
          throw new Error(
            "Git snapshot returned a different workspace identity",
          );
        }
        await options.git.retainSnapshot({ workspace, snapshot, scope });
        await requireWorkspace(input.workspace, authority);
        return { ...snapshot, runId };
      });
    },
    async getSnapshotDiff(
      input: Parameters<DefaultGitService["getSnapshotDiff"]>[0],
    ) {
      return await lease.withSettlementAuthority(async (authority) => {
        const workspace = await requireWorkspace(input.workspace, authority);
        const diff = await options.git.getSnapshotDiff({ ...input, workspace });
        await requireWorkspace(input.workspace, authority);
        return diff;
      });
    },
  };
}
