import type { DefaultGitService } from "@repo/git-service";
import {
  buildDiffContentFromPatch,
  buildGitStatusResponse,
  type DiffContent,
  type GitStatusReady,
} from "@repo/shared-types";
import { appServerJsonByteLength, type WorkspaceId } from "@repo/platform-protocol";
import { isReservedNativeWorkspacePath } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  LocalWorkspaceGitDiffParamsSchema,
  LocalWorkspaceGitStatusParamsSchema,
  type LocalWorkspaceGitDiffParams,
  type LocalWorkspaceGitStatusParams,
} from "./protocol.js";
import { AppServerOperationError } from "./server.js";

type ReadGit = Pick<DefaultGitService, "getStatus" | "getDiff" | "getFileLineCounts" | "getUntrackedFileDiff">;

/** Trusted held-root owner; no client-supplied filesystem root or Run identity. */
export interface LocalWorkspaceGitReadBinding {
  readonly filesystemRoot: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  /** Fresh grant/physical identity check after the original held root closes. */
  authorizeResult(): Promise<void>;
  createGit(signal: AbortSignal): Promise<ReadGit>;
  /** Resolves only after every original native loan has positively closed. */
  close(): Promise<void>;
}

type ReadOperation = { binding?: LocalWorkspaceGitReadBinding; cleanupUnknown: boolean };
const retainedReadOwners = new Set<LocalWorkspaceGitReads>();
const MAX_READS = 4;
const MAX_FILES = 200;
const MAX_PATCH_BYTES = 64 * 1024;
const MAX_PATCH_LINES = 4_096;
const MAX_RESULT_BYTES = 512 * 1024;
const READ_TIMEOUT_MS = 15_000;

/** Observational current-workspace queries, separate from immutable Turn review. */
export class LocalWorkspaceGitReads {
  private readonly operations = new Set<ReadOperation>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private stopping = false;
  private cleanupUnknown = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly bindWorkspace: (workspaceId: WorkspaceId) => Promise<LocalWorkspaceGitReadBinding>) {}

  status(input: LocalWorkspaceGitStatusParams): Promise<GitStatusReady> {
    const params = LocalWorkspaceGitStatusParamsSchema.parse(input);
    return this.read(params.workspaceId, async (git, binding, check) => {
      const status = await git.getStatus({ workspaceRoot: binding.filesystemRoot });
      await check();
      const entries = status.entries.filter((entry) => !isReservedNativeWorkspacePath(entry.path));
      if (entries.length > MAX_FILES) throw oversized();
      const result = buildGitStatusResponse({ ...status, entries }, null, null);
      if (result.files.length) {
        const counts = await git.getFileLineCounts({
          workspace: { filesystemRoot: binding.filesystemRoot },
          paths: result.files.map((file) => file.path),
        });
        await check();
        const byPath = new Map(counts.map((count) => [count.path, count]));
        for (const file of result.files) {
          const count = byPath.get(file.path);
          if (count) { file.additions = count.additions; file.deletions = count.deletions; }
        }
      }
      assertResultBudget(result);
      return result;
    });
  }

  diff(input: LocalWorkspaceGitDiffParams): Promise<DiffContent> {
    const params = LocalWorkspaceGitDiffParamsSchema.parse(input);
    if (isReservedNativeWorkspacePath(params.path)) {
      return Promise.reject(new AppServerOperationError(
        400, "invalid_request", "Reserved workspace paths cannot be reviewed", "workspace_git_reserved_path", false,
      ));
    }
    return this.read(params.workspaceId, async (git, binding, check) => {
      const workspace = { filesystemRoot: binding.filesystemRoot };
      let patch: string;
      if (!params.staged) {
        const status = await git.getStatus({ workspaceRoot: binding.filesystemRoot });
        await check();
        const untracked = status.entries.some((entry) => entry.path === params.path && entry.kind === "untracked");
        if (untracked) {
          const diff = await git.getUntrackedFileDiff({ workspace, path: params.path });
          await check();
          // A path confirmed untracked must not silently become an empty review
          // when its filename or a concurrent change cannot be represented.
          if (!diff) throw unavailable();
          patch = diff.patch;
        } else {
          patch = (await git.getDiff({ workspace, paths: [params.path], staged: false })).patch;
          await check();
        }
      } else {
        patch = (await git.getDiff({ workspace, paths: [params.path], staged: true })).patch;
        await check();
      }
      if (new TextEncoder().encode(patch).byteLength > MAX_PATCH_BYTES || patch.split("\n").length > MAX_PATCH_LINES) {
        throw oversized();
      }
      const result = patch.length ? buildDiffContentFromPatch(patch, params.path) : {
        oldPath: params.path, newPath: params.path, hunks: [],
        isBinary: false, isNewFile: false, isDeleted: false,
      };
      if (!result) throw unavailable();
      assertResultBudget(result);
      return result;
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.controller.abort("Local workspace Git reads are shutting down");
    this.shutdownPromise = Promise.allSettled([...this.pending]).then(() => {
      if (this.cleanupUnknown || this.operations.size) throw unavailable("workspace_git_cleanup_unconfirmed");
    });
    return this.shutdownPromise;
  }

  private read<T>(workspaceId: WorkspaceId, operation: (
    git: ReadGit, binding: LocalWorkspaceGitReadBinding, check: () => Promise<void>,
  ) => Promise<T>): Promise<T> {
    if (this.stopping || this.cleanupUnknown) return Promise.reject(unavailable());
    if (this.operations.size >= MAX_READS) return Promise.reject(unavailable("workspace_git_busy"));
    const owner: ReadOperation = { cleanupUnknown: false };
    this.operations.add(owner);
    const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
    // Register the original operation before invoking any asynchronous binding.
    const pending = Promise.resolve().then(async () => {
      try {
        owner.binding = await this.bindWorkspace(workspaceId);
        const binding = owner.binding;
        const signal = AbortSignal.any([binding.signal, this.controller.signal, deadline]);
        const check = async () => {
          signal.throwIfAborted();
          await binding.assertCurrent();
          signal.throwIfAborted();
        };
        let result: T;
        try {
          await check();
          const git = await binding.createGit(signal);
          await check();
          result = await operation(git, binding, check);
          await check();
        } finally {
          try { await binding.close(); }
          catch {
            owner.cleanupUnknown = this.cleanupUnknown = true;
            retainedReadOwners.add(this);
            throw unavailable("workspace_git_cleanup_unconfirmed");
          }
        }
        await binding.authorizeResult();
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof AppServerOperationError) throw error;
        throw unavailable();
      } finally {
        if (!owner.cleanupUnknown) this.operations.delete(owner);
      }
    });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }
}

function unavailable(code = "workspace_git_unavailable"): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "Workspace Git review is unavailable", code, false);
}

function oversized(): AppServerOperationError {
  return new AppServerOperationError(413, "invalid_request", "Workspace Git review exceeds its read limit", "workspace_git_too_large", false);
}

function assertResultBudget(result: unknown): void {
  if (appServerJsonByteLength(result) > MAX_RESULT_BYTES) throw oversized();
}
