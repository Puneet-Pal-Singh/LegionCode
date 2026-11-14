import type { DefaultGitService, GitStatusEntry } from "@repo/git-service";
import { buildGitStatusResponse } from "@repo/shared-types";
import {
  TurnAdmissionSchema,
  ToolCallItemContentSchema,
  appServerJsonByteLength,
  type TurnAdmission,
} from "@repo/platform-protocol";
import type {
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import { RuntimeWorkspaceScope } from "@legioncode/execution-engine/runtime/engine/RuntimeWorkspaceScope";
import {
  GIT_DIFF_TOOL_INPUT_SCHEMA,
  GIT_STATUS_TOOL_INPUT_SCHEMA,
} from "@legioncode/execution-engine/runtime/tools/CodingToolRegistry";
import { isReservedNativeWorkspacePath } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];
const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024;

/** Model adapter only. The existing Git service owns parsing/execution and the
 * original active lease owns every descriptor, process and closure receipt. */
export class LocalCapturedGitReadWorker implements WorkerProtocolPort {
  private readonly admission: TurnAdmission;
  private readonly pending = new Set<Promise<WorkerToolResult>>();

  constructor(
    private readonly options: {
      readonly admission: TurnAdmission;
      readonly binding: {
        readonly filesystemRoot: string;
        readonly signal: AbortSignal;
        assertCurrent(): Promise<void>;
      };
      readonly git: Pick<DefaultGitService, "getStatus" | "getDiff">;
    },
  ) {
    this.admission = TurnAdmissionSchema.parse(options.admission);
  }

  executeTool(input: ExecutionInput): Promise<WorkerToolResult> {
    if (this.pending.size >= 4)
      return Promise.resolve(failure("Local Git reads are busy"));
    let captured: ExecutionInput;
    try {
      captured = {
        ...input,
        workspace: { ...input.workspace },
        toolCall: ToolCallItemContentSchema.parse(input.toolCall),
      };
    } catch {
      return Promise.resolve(failure("Invalid local Git read"));
    }
    // Custody precedes every asynchronous binding or process collaborator.
    const operation = Promise.resolve()
      .then(() => this.read(captured))
      .catch(() =>
        failure(
          "Local Git read failed; its original resource owner retains any uncertain cleanup",
        ),
      );
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation));
    return operation;
  }

  async awaitQuiescence(input: {
    readonly turnId: ExecutionInput["turnId"];
    readonly timeoutMs: number;
  }): Promise<boolean> {
    if (
      input.turnId !== this.admission.turn.id ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs < 0
    )
      return false;
    if (!this.pending.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.pending]).then(
          () => this.pending.size === 0,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), input.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async read(input: ExecutionInput): Promise<WorkerToolResult> {
    const { run, turn, runAttemptId } = this.admission;
    const binding = this.options.binding;
    const signal = input.signal
      ? AbortSignal.any([binding.signal, input.signal])
      : binding.signal;
    const check = async () => {
      signal.throwIfAborted();
      if (
        input.runId !== run.id ||
        input.turnId !== turn.id ||
        input.runAttemptId !== runAttemptId ||
        input.workspace.runId !== run.id ||
        input.workspace.workspaceId !== run.workspaceId ||
        input.workspace.permissionProfileId !== run.permissionProfileId ||
        input.workspace.workerId !== run.workerId ||
        input.workspace.executionLocation !== "desktop_local" ||
        input.workspace.filesystemRoot !== binding.filesystemRoot
      )
        throw new Error("Local Git read belongs to another attempt");
      await binding.assertCurrent();
      signal.throwIfAborted();
    };
    const name = input.toolCall.toolName;
    if (name !== "git_status" && name !== "git_diff")
      throw new Error("Tool is outside the local Git read capability");
    const parsed =
      name === "git_status"
        ? GIT_STATUS_TOOL_INPUT_SCHEMA.parse(input.toolCall.input)
        : GIT_DIFF_TOOL_INPUT_SCHEMA.parse(input.toolCall.input);
    const normalized = new RuntimeWorkspaceScope({
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
      turnId: turn.id,
      runAttemptId,
      root: binding.filesystemRoot,
    }).normalizeToolInput(parsed);
    const path = typeof normalized.path === "string" ? normalized.path : ".";
    if (isReservedNativeWorkspacePath(path))
      throw new Error("Reserved workspace paths cannot be read through Git");
    await check();
    const status = await this.options.git.getStatus({
      workspaceRoot: binding.filesystemRoot,
      runId: run.id,
    });
    await check();
    const entries = status.entries.filter(publicEntry);
    if (entries.length > MAX_FILES)
      throw new Error("Local Git read exceeds its file bound");
    if (name === "git_status") {
      const result = buildGitStatusResponse(
        { branch: status.branch, entries },
        null,
        null,
      );
      return output(JSON.stringify(result), {
        operation: name,
        workspaceId: run.workspaceId,
      });
    }
    const staged = normalized.staged === true;
    const paths = [
      ...new Set(
        entries.flatMap((entry) => {
          const names =
            entry.kind === "renamed_or_copied"
              ? [entry.previousPath, entry.path]
              : [entry.path];
          return names.filter(
            (name) =>
              path === "." || name === path || name.startsWith(`${path}/`),
          );
        }),
      ),
    ];
    if (paths.length > MAX_FILES)
      throw new Error("Local Git diff exceeds its file bound");
    // Explicit observed paths exclude the native reader's reserved namespace.
    // Empty here means no matching observed change, not an unrestricted pathspec.
    const patch = paths.length
      ? (
          await this.options.git.getDiff({
            workspace: {
              runId: run.id,
              filesystemRoot: binding.filesystemRoot,
            },
            paths,
            staged,
          })
        ).patch
      : "";
    await check();
    return output(patch, {
      operation: name,
      workspaceId: run.workspaceId,
      staged,
      paths,
    });
  }
}

function publicEntry(entry: GitStatusEntry): boolean {
  return (
    !isReservedNativeWorkspacePath(entry.path) &&
    (entry.kind !== "renamed_or_copied" ||
      !isReservedNativeWorkspacePath(entry.previousPath))
  );
}

function output(
  content: string,
  metadata: Record<string, string | boolean | string[]>,
): WorkerToolResult {
  const value = { content, metadata };
  if (appServerJsonByteLength(value) > MAX_BYTES)
    throw new Error("Local Git output exceeds its byte bound");
  return { kind: "completed", output: value };
}

function failure(message: string): WorkerToolResult {
  return {
    kind: "failed",
    disposition: "terminal",
    failure: {
      code: "policy_denied",
      message,
      details: null,
      retryable: false,
      correlationId: null,
    },
  };
}
