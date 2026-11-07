import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type RunAttemptId,
  type RunId,
  type ThreadId,
  type TurnId,
  type UserId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
} from "./executor.js";
import { createGitCommandFailedError, GitServiceError } from "./errors.js";
import type { GitFilesystemContext, GitWorkspaceSnapshot } from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";
import { assertGitObjectRetentionProfile } from "./object-retention-profile.js";

export interface GitSnapshotRetentionScope {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
}

export interface GitSnapshotRetentionInput {
  readonly workspace: GitFilesystemContext;
  readonly snapshot: GitWorkspaceSnapshot;
  readonly scope: GitSnapshotRetentionScope;
  /**
   * The original authority must freshly validate its mutation metadata graph,
   * including the original common object store, absent/empty alternates and
   * absent/empty grafts.
   * All calls, including this guard, borrow the same retained writer lease.
   */
  readonly assertStorageReady: () => Promise<void>;
}

export interface GitSnapshotRetentionResult {
  readonly reference: string;
  readonly treeId: string;
}

/**
 * Retain a complete captured tree before its immutable artifact is published.
 * Only this owner writes refs/legioncode/artifacts; there is no ref cleanup.
 * Git locks/CAS handle cooperating writers. The symbolic-ref preflight does
 * not claim atomic protection against hostile concurrent ref-type replacement.
 */
export async function retainGitWorkspaceSnapshot(
  executor: GitCommandExecutor,
  input: GitSnapshotRetentionInput,
): Promise<GitSnapshotRetentionResult> {
  const runId = RunIdSchema.parse(input.workspace.runId);
  const cwd = validateWorkspaceRoot(input.workspace.filesystemRoot);
  const scope = [
    UserIdSchema.parse(input.scope.userId),
    WorkspaceIdSchema.parse(input.scope.workspaceId),
    ThreadIdSchema.parse(input.scope.threadId),
    RunIdSchema.parse(input.scope.runId),
    TurnIdSchema.parse(input.scope.turnId),
    RunAttemptIdSchema.parse(input.scope.runAttemptId),
  ];
  const treeId = input.snapshot.treeId;
  if (
    input.snapshot.runId !== runId ||
    input.snapshot.filesystemRoot !== cwd ||
    scope[3] !== runId ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(treeId)
  ) {
    throw new GitServiceError(
      "invalid_git_input",
      "Snapshot retention requires the same exact attempt and workspace",
    );
  }
  const deadline = performance.now() + DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const checkDeadline = () => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      throw new GitServiceError(
        "git_command_failed",
        "Snapshot retention exceeded its deadline",
      );
    }
    return remaining;
  };
  const assertStorage = async () => {
    checkDeadline();
    await input.assertStorageReady();
    checkDeadline();
  };
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(scope)),
    ),
  );
  const key = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const reference = `refs/legioncode/artifacts/v1/${key}/${treeId}`;
  const execute = async (args: readonly string[], mutating = false) => {
    const command = ["--no-replace-objects", ...args];
    const result = await executor.execute({
      runId,
      cwd,
      args: command,
      timeoutMs: checkDeadline(),
      ...(mutating ? {} : { readOnlyProbe: true as const }),
    });
    if (result.indexPublication === "indeterminate") {
      throw new GitServiceError(
        "git_commit_indeterminate",
        "Git snapshot retention outcome is indeterminate",
      );
    }
    checkDeadline();
    if (result.stdout.length > 4096 || result.stderr.length > 4096) {
      throw new GitServiceError(
        "git_command_failed",
        "Snapshot retention output exceeded its bound",
      );
    }
    return { command, result };
  };
  const checked = async (args: readonly string[]) => {
    const { command, result } = await execute(args);
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        command,
        result.exitCode,
        result.stderr,
      );
    }
    return result.stdout;
  };
  const rejectSymbolicReference = async () => {
    const { command, result } = await execute([
      "symbolic-ref",
      "-q",
      reference,
    ]);
    if (result.exitCode === 0) {
      throw new GitServiceError(
        "invalid_git_input",
        "Snapshot retention cannot replace a symbolic reference",
      );
    }
    // Exit 1 means missing or non-symbolic. All other errors fail closed.
    if (result.exitCode !== 1 || result.stdout.length !== 0) {
      throw createGitCommandFailedError(
        command,
        result.exitCode,
        result.stderr,
      );
    }
  };
  const readReference = async () => {
    await rejectSymbolicReference();
    const output = await checked([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      reference,
    ]);
    if (output.length === 0) return false;
    // for-each-ref accepts prefix patterns: descendants are not this receipt.
    if (output !== `${reference}\0${treeId}\0tree\0\n`) {
      throw new GitServiceError(
        "git_command_failed",
        "Snapshot retention reference does not match its exact captured tree",
      );
    }
    return true;
  };
  const assertClosure = async () => {
    if ((await checked(["cat-file", "-t", treeId])) !== "tree\n") {
      throw new GitServiceError(
        "invalid_git_input",
        "Snapshot retention requires a tree object",
      );
    }
    // Verify every reachable tree/blob without listing an unbounded closure.
    await checked([
      "rev-list",
      "--objects",
      "--missing=error",
      "--quiet",
      treeId,
    ]);
  };

  await assertStorage();
  await assertGitObjectRetentionProfile(
    executor,
    input.workspace,
    checkDeadline(),
  );
  await assertClosure();
  if (!(await readReference())) {
    await assertStorage();
    await rejectSymbolicReference();
    const { command, result } = await execute(
      [
        "update-ref",
        "--no-deref",
        reference,
        treeId,
        "0".repeat(treeId.length),
      ],
      true,
    );
    // Another cooperating writer may have created exactly this same receipt.
    if (!(await readReference())) {
      if (result.exitCode !== 0) {
        throw createGitCommandFailedError(
          command,
          result.exitCode,
          result.stderr,
        );
      }
      throw new GitServiceError(
        "git_command_failed",
        "Git did not create the exact snapshot retention reference",
      );
    }
  }
  await assertClosure();
  await assertStorage();
  return { reference, treeId };
}
