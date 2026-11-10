import { lstat, type FileHandle } from "node:fs/promises";
import {
  RunSchema,
  TurnSchema,
  RunAttemptIdSchema,
  ToolCallItemContentSchema,
} from "@repo/platform-protocol";
import type {
  RuntimeKernelDependencies,
  StartTurnInput,
  ToolAuthorizationPort,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import {
  EDIT_FILE_TOOL_INPUT_SCHEMA,
  WRITE_FILE_TOOL_INPUT_SCHEMA,
} from "../tools/CodingToolRegistry.js";
import { assertLocalFileToolAuthorized } from "./LocalToolApproval.js";
import { replaceExactText } from "../tools/ExactTextEdit.js";
import { RuntimeWorkspaceScope } from "../engine/RuntimeWorkspaceScope.js";
import {
  NativeFilesystemBridge,
  NativeFilesystemError,
  type NativeFilesystemExecution,
} from "./NativeFilesystemBridge.js";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];
export type LocalMutationIdentity = {
  readonly workspaceId: StartTurnInput["run"]["workspaceId"];
  readonly threadId: StartTurnInput["run"]["threadId"];
  readonly runId: StartTurnInput["run"]["id"];
  readonly turnId: StartTurnInput["turn"]["id"];
  readonly runAttemptId: StartTurnInput["runAttemptId"];
};

/** Guarded file-only worker. Composition supplies the real writer lease, full
 * capture and the same trusted policy owner as the kernel. Native I/O requires
 * the exact recorded active tool plus its explicit approval or policy decision.
 */
export class LocalGuardedFileWorker implements WorkerProtocolPort {
  private readonly identity: LocalMutationIdentity;
  private readonly admission: Pick<
    StartTurnInput,
    "run" | "turn" | "runAttemptId"
  >;
  private readonly filesystem: NativeFilesystemBridge;
  private readonly rootDirectory: FileHandle;
  private readonly filesystemRoot: string;
  private readonly bindingSignal: AbortSignal;
  private readonly active = new Set<Promise<WorkerToolResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
      readonly binding: {
        readonly workspace: {
          readonly workspaceId: LocalMutationIdentity["workspaceId"];
        };
        readonly filesystemRoot: string;
        readonly rootDirectory: FileHandle;
        /** Borrowed canonical shared lease, retained by the native child at FD6. */
        readonly writerLease: { readonly fd: number };
        readonly signal: AbortSignal;
        assertCurrent(): void | Promise<void>;
      };
      readonly helperPath: string;
      readonly toolAuthorization: ToolAuthorizationPort;
      readonly observeExecution?: (
        execution: NativeFilesystemExecution,
      ) => void;
      readonly lifecycleEvents: Pick<
        RuntimeKernelDependencies["lifecycleEvents"],
        "replay"
      >;
      /** Host verifies the exact lease plus a real full-capture baseline. */
      readonly assertMutationReady: (
        identity: LocalMutationIdentity,
      ) => Promise<void>;
    },
  ) {
    this.admission = {
      run: RunSchema.parse(options.admission.run),
      turn: TurnSchema.parse(options.admission.turn),
      runAttemptId: RunAttemptIdSchema.parse(options.admission.runAttemptId),
    };
    const { run, turn, runAttemptId } = this.admission;
    if (
      turn.runId !== run.id ||
      turn.threadId !== run.threadId ||
      options.binding.workspace.workspaceId !== run.workspaceId
    ) {
      throw new Error(
        "Local mutation admission does not match the granted workspace",
      );
    }
    this.identity = Object.freeze({
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
      turnId: turn.id,
      runAttemptId,
    });
    this.rootDirectory = options.binding.rootDirectory;
    this.filesystemRoot = options.binding.filesystemRoot;
    this.bindingSignal = options.binding.signal;
    this.filesystem = new NativeFilesystemBridge({
      helperPath: options.helperPath,
      rootDirectory: options.binding.rootDirectory,
      writerLease: options.binding.writerLease,
      observeExecution: options.observeExecution,
    });
  }

  executeTool(input: ExecutionInput): Promise<WorkerToolResult> {
    let captured: ExecutionInput;
    try {
      captured = {
        ...input,
        workspace: { ...input.workspace },
        toolCall: ToolCallItemContentSchema.parse(input.toolCall),
        approval: input.approval ? { ...input.approval } : null,
      };
    } catch (error) {
      return Promise.resolve(failure(error));
    }
    const operation = this.tail
      .then(() => this.execute(captured))
      .catch(failure);
    this.tail = operation;
    this.active.add(operation);
    void operation.then(() => this.active.delete(operation));
    return operation;
  }

  async awaitQuiescence(
    input: Parameters<NonNullable<WorkerProtocolPort["awaitQuiescence"]>>[0],
  ): Promise<boolean> {
    if (
      input.turnId !== this.identity.turnId ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs < 0
    )
      return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...this.active]).then(() => this.active.size === 0),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), input.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async execute(input: ExecutionInput): Promise<WorkerToolResult> {
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.bindingSignal])
      : this.bindingSignal;
    const name = input.toolCall.toolName;
    if (name !== "write_file" && name !== "edit_file")
      throw new Error("Tool is outside the guarded file capability");
    const parsed =
      name === "edit_file"
        ? EDIT_FILE_TOOL_INPUT_SCHEMA.parse(input.toolCall.input)
        : WRITE_FILE_TOOL_INPUT_SCHEMA.parse(input.toolCall.input);
    if (
      Buffer.byteLength(
        "content" in parsed ? parsed.content : parsed.oldText,
        "utf8",
      ) > 200_000 ||
      ("newText" in parsed &&
        Buffer.byteLength(parsed.newText, "utf8") > 200_000)
    ) {
      throw new Error(
        "File tool input exceeds the canonical 200000-byte limit",
      );
    }
    for (const value of Object.values(parsed)) {
      if (
        typeof value === "string" &&
        Buffer.from(value, "utf8").toString("utf8") !== value
      ) {
        throw new Error("File tool input requires well-formed UTF-8 text");
      }
    }
    const assertReady = async () => {
      signal.throwIfAborted();
      const { run } = this.admission;
      if (
        input.runId !== this.identity.runId ||
        input.turnId !== this.identity.turnId ||
        input.runAttemptId !== this.identity.runAttemptId ||
        input.workspace.runId !== run.id ||
        input.workspace.workspaceId !== run.workspaceId ||
        input.workspace.filesystemRoot !== this.filesystemRoot ||
        input.workspace.permissionProfileId !== run.permissionProfileId ||
        input.workspace.executionLocation !== "desktop_local" ||
        input.workspace.workerId !== run.workerId ||
        run.executionCapability !== "repository" ||
        run.mode === "ask" ||
        run.mode === "review" ||
        run.mode === "plan"
      ) {
        throw new Error(
          "Local mutation identity or permission context changed",
        );
      }
      await this.options.binding.assertCurrent();
      const [root, descriptor] = await Promise.all([
        lstat(this.filesystemRoot, { bigint: true }),
        this.rootDirectory.stat({ bigint: true }),
      ]);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        !descriptor.isDirectory() ||
        root.dev !== descriptor.dev ||
        root.ino !== descriptor.ino
      ) {
        throw new Error("Mutation root FD does not match the current grant");
      }
      await this.options.assertMutationReady(this.identity);
      await assertLocalFileToolAuthorized({
        admission: this.admission,
        lifecycleEvents: this.options.lifecycleEvents,
        toolAuthorization: this.options.toolAuthorization,
        input,
        schema:
          name === "edit_file"
            ? EDIT_FILE_TOOL_INPUT_SCHEMA
            : WRITE_FILE_TOOL_INPUT_SCHEMA,
      });
      signal.throwIfAborted();
    };
    await assertReady();
    let replacements = 0;
    const scope = new RuntimeWorkspaceScope({
      ...this.identity,
      root: this.filesystemRoot,
    });
    const normalized = scope.normalizeToolInput(parsed);
    if (typeof normalized.path !== "string")
      throw new Error("Canonical mutation path is missing");
    const result = await this.filesystem.mutate({
      path: normalized.path,
      signal,
      beforeCommit: assertReady,
      prepare: (current) => {
        if ("content" in parsed) return parsed.content;
        if (current === null)
          throw new Error("Exact edit requires an existing workspace file");
        const edit = replaceExactText(current, parsed, {
          maxOutputBytes: 4 * 1024 * 1024,
        });
        replacements = edit.count;
        return edit.content;
      },
    });
    return {
      kind: "completed",
      output: {
        content:
          name === "edit_file"
            ? `Edited ${result.path} (${replacements} replacement(s))`
            : `Wrote ${result.bytes} bytes to ${result.path}`,
        metadata: {
          path: result.path,
          bytes: result.bytes,
          created: result.created,
          ...(name === "edit_file" ? { replacementCount: replacements } : {}),
        },
      },
    };
  }
}

function failure(error: unknown, stopped = false): WorkerToolResult {
  const native = error instanceof NativeFilesystemError ? error : null;
  if (native?.code === 4 && stopped)
    return { kind: "cancelled", reason: native.message };
  const terminal = native?.code === 3 || native?.code === 4;
  const code = terminal
    ? "internal_error"
    : native?.code === 2
      ? "conflict"
      : native?.code === 1
        ? "validation_failed"
        : "policy_denied";
  return {
    kind: "failed",
    disposition: terminal ? "terminal" : "recoverable",
    failure: {
      code,
      message:
        error instanceof Error ? error.message : "Local file mutation failed",
      retryable: false,
      correlationId: null,
      details: null,
    },
  };
}
