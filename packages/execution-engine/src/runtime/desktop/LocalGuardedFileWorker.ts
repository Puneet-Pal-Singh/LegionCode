import { lstat, type FileHandle } from "node:fs/promises";
import {
  RunSchema,
  TurnSchema,
  RunAttemptIdSchema,
  ToolCallItemContentSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type {
  RuntimeKernelDependencies,
  StartTurnInput,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import {
  EDIT_FILE_TOOL_INPUT_SCHEMA,
  WRITE_FILE_TOOL_INPUT_SCHEMA,
} from "../tools/CodingToolRegistry.js";
import { replaceExactText } from "../tools/ExactTextEdit.js";
import {
  NativeFilesystemBridge,
  NativeFilesystemError,
} from "./NativeFilesystemBridge.js";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];
export type LocalMutationIdentity = {
  readonly workspaceId: StartTurnInput["run"]["workspaceId"];
  readonly threadId: StartTurnInput["run"]["threadId"];
  readonly runId: StartTurnInput["run"]["id"];
  readonly turnId: StartTurnInput["turn"]["id"];
  readonly runAttemptId: StartTurnInput["runAttemptId"];
};

/** Supervised file-only worker. Composition must supply a real writer lease and
 * full baseline/final capture readiness; omitted_read_only is never sufficient.
 * Only the kernel's recorded, exact approved tool request can reach native I/O.
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
        readonly signal: AbortSignal;
        assertCurrent(): void | Promise<void>;
      };
      readonly helperPath: string;
      readonly lifecycleEvents: Pick<
        RuntimeKernelDependencies["lifecycleEvents"],
        "replay"
      >;
      /** Owner03 must verify the exact lease plus a real full-capture baseline. */
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
      await this.assertApproved(input, parsed);
      signal.throwIfAborted();
    };
    await assertReady();
    let replacements = 0;
    const result = await this.filesystem.mutate({
      path: parsed.path,
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
        path: result.path,
        bytes: result.bytes,
        created: result.created,
        ...(name === "edit_file" ? { replacementCount: replacements } : {}),
      },
    };
  }

  private async assertApproved(
    input: ExecutionInput,
    parsed: Record<string, unknown>,
  ): Promise<void> {
    if (
      !input.approval ||
      input.approval.decision !== "approved" ||
      input.approval.timedOut
    ) {
      throw new Error(
        "Initial local file mutation requires an explicit canonical approval",
      );
    }
    const events: LifecycleEvent[] = [];
    let afterSequence: number | null = null;
    do {
      const page = await this.options.lifecycleEvents.replay({
        turnId: this.identity.turnId,
        afterSequence,
        limit: 1_000,
      });
      events.push(...page.events);
      afterSequence = page.nextSequence;
    } while (afterSequence !== null);
    if (
      events.some(
        (event) =>
          event.threadId !== this.identity.threadId ||
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted",
      ) ||
      events.at(-1)?.runAttemptId !== this.identity.runAttemptId
    )
      throw new Error("Approval turn is no longer active");
    const tool = events.find(
      (event) =>
        event.type === "tool_call.started" &&
        event.toolCallId === input.toolCall.toolCallId &&
        event.runAttemptId === this.identity.runAttemptId,
    );
    if (
      !tool ||
      tool.type !== "tool_call.started" ||
      tool.payload.toolName !== input.toolCall.toolName
    )
      throw new Error("Canonical tool request is missing");
    const normalize =
      input.toolCall.toolName === "edit_file"
        ? EDIT_FILE_TOOL_INPUT_SCHEMA
        : WRITE_FILE_TOOL_INPUT_SCHEMA;
    const inputs = events.filter(
      (event) =>
        event.type === "tool_call.input_delta" &&
        event.toolCallId === input.toolCall.toolCallId &&
        event.itemId === tool.itemId &&
        event.runAttemptId === this.identity.runAttemptId &&
        event.sequence > tool.sequence &&
        "input" in event.payload,
    );
    const recordedInput = inputs[0];
    if (
      inputs.length !== 1 ||
      recordedInput?.type !== "tool_call.input_delta" ||
      JSON.stringify(normalize.parse(recordedInput.payload.input)) !==
        JSON.stringify(parsed)
    )
      throw new Error("Approved tool input does not match execution");
    const approvalItems = new Set(
      events
        .filter(
          (event) =>
            event.type === "item.started" &&
            event.payload.kind === "approval_request" &&
            event.payload.parentItemId === tool.itemId &&
            event.runAttemptId === this.identity.runAttemptId,
        )
        .map((event) => ("itemId" in event ? event.itemId : "")),
    );
    const requests = events.filter(
      (event) =>
        event.type === "approval.requested" &&
        approvalItems.has(event.itemId) &&
        event.runAttemptId === this.identity.runAttemptId,
    );
    if (requests.length !== 1 || requests[0]?.type !== "approval.requested")
      throw new Error("Approval request is missing or ambiguous");
    const request = requests[0];
    const metadata = request.payload.metadata;
    if (
      recordedInput.sequence >= request.sequence ||
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      metadata.toolName !== input.toolCall.toolName ||
      metadata.permissionProfileId !== this.admission.run.permissionProfileId ||
      metadata.grantWorkspaceId !== this.identity.workspaceId
    ) {
      throw new Error(
        "Approval policy context does not match the admitted tool request",
      );
    }
    const decisions = events.filter(
      (event) =>
        event.type === "approval.decided" &&
        event.approvalId === request.approvalId,
    );
    const decision = decisions[0];
    if (
      decisions.length !== 1 ||
      decision?.type !== "approval.decided" ||
      decision.itemId !== request.itemId ||
      decision.runAttemptId !== this.identity.runAttemptId ||
      decision.sequence <= request.sequence ||
      decision.payload.status !== "approved" ||
      decision.payload.decidedBy !== input.approval.decidedBy ||
      decision.payload.reason !== input.approval.reason ||
      decision.payload.grantScope !== input.approval.grantScope ||
      events.some(
        (event) =>
          "toolCallId" in event &&
          event.toolCallId === input.toolCall.toolCallId &&
          (event.type === "tool_call.completed" ||
            event.type === "tool_call.failed" ||
            event.type === "tool_call.declined" ||
            event.type === "tool_call.interrupted"),
      )
    ) {
      throw new Error(
        "Canonical approval receipt does not authorize this active tool request",
      );
    }
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
