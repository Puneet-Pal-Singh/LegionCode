import { LifecycleTransitionError, toPublicProtocolError } from "@repo/platform-protocol";
import type {
  ItemId,
  ProtocolError,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { RuntimeKernelError, toProtocolError } from "./errors.js";
import type { ToolAuthorizationPort, WorkerProtocolPort } from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type {
  ApprovalResolution,
  ToolAuthorizationResult,
  ToolResult,
  WorkerToolResult,
} from "./types.js";
import { mapWorkerResultEvents } from "./WorkerResultEventMapper.js";

export class ToolExecutionCoordinator {
  constructor(
    private readonly worker: WorkerProtocolPort,
    private readonly authorization: ToolAuthorizationPort,
    private readonly approvals: ApprovalCoordinator,
    private readonly lifecycle: RuntimeLifecycleCoordinator,
  ) {}

  async execute(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const authorization = await this.authorization.authorize({
      run,
      itemId,
      toolCall,
    });
    const canonicalToolCall =
      authorization.status === "rejected" ? toolCall : authorization.toolCall;
    await this.lifecycle.startToolCall(
      itemId,
      canonicalToolCall.toolCallId,
      canonicalToolCall.toolName,
      canonicalToolCall.input,
      canonicalToolCall.callBatchId,
      canonicalToolCall.display,
    );
    try {
      return await this.executeAuthorizedTool(
        run,
        runAttemptId,
        turn,
        workspace,
        itemId,
        canonicalToolCall,
        authorization,
        signal,
      );
    } catch (error) {
      if (
        error instanceof RuntimeKernelError &&
        error.code === "turn_cancelled"
      ) {
        throw error;
      }
      if (
        error instanceof RuntimeKernelError &&
        error.code === "approval_denied"
      ) {
        await this.lifecycle.declineToolCall(
          toolCall.toolCallId,
          error.message,
        );
        const failure = toProtocolError(error);
        return {
          toolCallId: toolCall.toolCallId,
          output: {
            error: {
              code: failure.code,
              message: failure.message,
              details: failure.details,
              retryable: false,
            },
          },
          failure: { ...failure, retryable: false },
        };
      } else {
        await this.lifecycle.failToolCall(
          toolCall.toolCallId,
          toProtocolError(error),
        );
      }
      throw error;
    }
  }

  private async executeAuthorizedTool(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    authorization: ToolAuthorizationResult,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (authorization.status === "rejected") {
      throw new RuntimeKernelError(authorization.code, authorization.reason);
    }
    const approval =
      authorization.status === "approval_required"
        ? await this.approvals.requestAndWait(
            run,
            runAttemptId,
            turn,
            itemId,
            authorization.request,
            signal,
          )
        : null;
    const liveOutput = createLiveToolOutput(this.lifecycle, toolCall.toolCallId, signal);
    let result: Extract<WorkerToolResult, { kind: "completed" | "failed" }>;
    try {
      result = await this.executeToCompletion(
        run, runAttemptId, turn, workspace, itemId, authorization.toolCall, approval, liveOutput, signal,
      );
    } finally {
      liveOutput.seal();
      // The original worker must settle AND every synchronously admitted append
      // must drain before either success or error reaches terminal handling.
      await liveOutput.drain();
    }
    if (result.kind === "failed") {
      const failure = toPublicProtocolError(result.failure);
      if (result.disposition === "terminal") {
        throw this.workerFailure(failure);
      }
      await this.lifecycle.failToolCall(toolCall.toolCallId, failure);
      return {
        toolCallId: toolCall.toolCallId,
        output: {
          error: {
            code: failure.code,
            message: failure.message,
            details: failure.details,
            retryable: failure.retryable,
          },
        },
        failure,
      };
    }
    if (signal?.aborted || this.lifecycle.isTerminal) {
      throw new LifecycleTransitionError(
        "tool_call",
        "active",
        "interrupted",
        "turn was interrupted before tool completion",
      );
    }
    await this.emitWorkerResultEvents(
      run,
      itemId,
      authorization.toolCall,
      result,
      liveOutput.persistedPrefix(),
      liveOutput.remainingBytes(),
    );
    await this.lifecycle.completeToolCall(toolCall.toolCallId, result.output);
    return { toolCallId: toolCall.toolCallId, output: result.output };
  }

  private async executeToCompletion(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
    liveOutput: LiveToolOutput,
    signal?: AbortSignal,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" | "failed" }>> {
    const initial = await this.callWorker(
      run,
      runAttemptId,
      turn,
      workspace,
      toolCall,
      approval,
      liveOutput,
      signal,
    );
    if (initial.kind === "completed") {
      return initial;
    }
    if (initial.kind === "failed") {
      return initial;
    }
    if (initial.kind === "cancelled") {
      throw new RuntimeKernelError("turn_cancelled", initial.reason);
    }
    if (approval !== null) {
      throw new RuntimeKernelError(
        "approval_retry_required",
        `Worker requested approval again for ${toolCall.toolCallId}`,
      );
    }
    const workerApproval = await this.approvals.requestAndWait(
      run,
      runAttemptId,
      turn,
      itemId,
      initial.request,
      signal,
    );
    return await this.resolveApprovedRetry(
      run,
      runAttemptId,
      turn,
      workspace,
      toolCall,
      workerApproval,
      liveOutput,
      signal,
    );
  }

  private async resolveApprovedRetry(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution,
    liveOutput: LiveToolOutput,
    signal?: AbortSignal,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" | "failed" }>> {
    const result = await this.callWorker(
      run,
      runAttemptId,
      turn,
      workspace,
      toolCall,
      approval,
      liveOutput,
      signal,
    );
    if (result.kind === "approval_required") {
      throw new RuntimeKernelError(
        "approval_retry_required",
        `Worker requested approval again for ${toolCall.toolCallId}`,
      );
    }
    if (result.kind === "failed") {
      return result;
    }
    if (result.kind === "cancelled") {
      throw new RuntimeKernelError("turn_cancelled", result.reason);
    }
    return result;
  }

  private async callWorker(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
    liveOutput: LiveToolOutput,
    signal?: AbortSignal,
  ): Promise<WorkerToolResult> {
    if (signal?.aborted) throw new RuntimeKernelError("turn_cancelled", "Turn stopped before worker dispatch");
    let dispatchOpen = true;
    try {
      return await this.worker.executeTool({
        runId: run.id, runAttemptId, turnId: turn.id, workspace, toolCall, approval, signal,
        onOutput: (delta) => dispatchOpen
          ? liveOutput.onOutput(delta)
          : rejectedOutput("Tool output arrived after its original dispatch settled"),
      });
    } finally {
      dispatchOpen = false;
      await liveOutput.drain();
    }
  }

  private workerFailure(failure: ProtocolError): RuntimeKernelError {
    return new RuntimeKernelError("worker_failed", failure.message, failure);
  }

  private async emitWorkerResultEvents(
    run: Run,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    result: Extract<WorkerToolResult, { kind: "completed" }>,
    persistedPrefix: string,
    remainingBytes: number,
  ): Promise<void> {
    const projection = mapWorkerResultEvents(
      run,
      itemId,
      result.output,
      result.events,
    );
    // Match the ENTIRE persisted prefix across mapped delta boundaries before
    // removing anything. A partial match must not erase nonduplicate final text.
    let matched = 0;
    for (const delta of projection.outputDeltas) {
      const count = Math.min(delta.length, persistedPrefix.length - matched);
      if (delta.slice(0, count) !== persistedPrefix.slice(matched, matched + count)) { matched = -1; break; }
      matched += count;
      if (matched === persistedPrefix.length) break;
    }
    if (persistedPrefix.length === 0) {
      // Preserve legacy display behavior: ONE append per mapped delta, with
      // the existing lifecycle owner's 4,000-UTF-16 cap. Never expand it here.
      for (const delta of projection.outputDeltas) {
        await this.lifecycle.appendToolOutput(toolCall.toolCallId, delta);
      }
    } else {
      let skip = matched === persistedPrefix.length ? matched : 0;
      const finalParts: string[] = [];
      for (const delta of projection.outputDeltas) {
        if (remainingBytes <= 0) break;
        const count = Math.min(skip, delta.length);
        skip -= count;
        const part = boundedUtf8Prefix(delta.slice(count), remainingBytes);
        if (part.text) finalParts.push(part.text);
        remainingBytes -= part.bytes;
        // Reaching a partial code point at the cap seals the display prefix;
        // later deltas must not fill that space after dropping earlier text.
        if (part.text.length < delta.length - count) break;
      }
      // The combined streamed display is <=64 KiB. Joining the bounded tail
      // before splitting limits this final sequence to at most 17 append events.
      // Only the display is capped: model output and all artifacts stay intact.
      await appendOutputChunks(this.lifecycle, toolCall.toolCallId, finalParts.join(""));
    }
    for (const artifact of projection.artifacts) {
      await this.lifecycle.createArtifact(itemId, artifact);
    }
  }
}

interface LiveToolOutput {
  onOutput(delta: string): Promise<void>;
  drain(): Promise<void>;
  seal(): void;
  persistedPrefix(): string;
  remainingBytes(): number;
}
function rejectedOutput(message: string): Promise<void> {
  const rejected = Promise.reject(new RuntimeKernelError("worker_failed", message));
  void rejected.catch(() => undefined);
  return rejected;
}
function createLiveToolOutput(
  lifecycle: RuntimeLifecycleCoordinator, toolCallId: ToolCallItemContent["toolCallId"], signal?: AbortSignal,
): LiveToolOutput {
  let sealed = false, admittedBytes = 0, persisted = "";
  let admissionFailure: RuntimeKernelError | undefined;
  let tail: Promise<void> = Promise.resolve();
  return {
    onOutput(delta) {
      if (sealed || signal?.aborted || lifecycle.isTerminal) return rejectedOutput("Tool output admission is sealed");
      const bytes = typeof delta === "string" ? new TextEncoder().encode(delta).byteLength : -1;
      if (bytes < 0 || bytes > 16 * 1024 || admittedBytes + bytes > 64 * 1024) {
        admissionFailure = new RuntimeKernelError("worker_failed", "Tool output exceeds its UTF-8 admission limit");
        sealed = true;
        return rejectedOutput(admissionFailure.message);
      }
      if (bytes === 0) return Promise.resolve();
      admittedBytes += bytes;
      // Register synchronously, before persistence can yield. Rejected tails
      // reject all queued successors; no later append can skip a failed prefix.
      const original = tail.then(() => appendOutputChunks(lifecycle, toolCallId, delta, part => { persisted += part; }));
      tail = original;
      void original.catch(() => { sealed = true; });
      return original;
    },
    async drain() { await tail; if (admissionFailure) throw admissionFailure; },
    seal() { sealed = true; },
    persistedPrefix() { return persisted; },
    // Count the admitted deltas, not a re-encoding of their concatenation.
    remainingBytes() { return 64 * 1024 - admittedBytes; },
  };
}
async function appendOutputChunks(
  lifecycle: RuntimeLifecycleCoordinator, toolCallId: ToolCallItemContent["toolCallId"], delta: string,
  persisted?: (part: string) => void,
): Promise<void> {
  // Existing lifecycle owner caps each event at 4,000 UTF-16 code units. Split
  // without bisecting a surrogate pair; each part also fits the 16 KiB byte cap.
  for (let offset = 0; offset < delta.length;) {
    let end = Math.min(offset + 4000, delta.length);
    if (end < delta.length && /[\uD800-\uDBFF]/u.test(delta[end - 1]!) && /[\uDC00-\uDFFF]/u.test(delta[end]!)) end--;
    const part = delta.slice(offset, end);
    await lifecycle.appendToolOutput(toolCallId, part);
    persisted?.(part);
    offset = end;
  }
}

/** Return an exact code-point-safe prefix without encoding/allocating an
 * unbounded final legacy value. UTF-8 replacement cost for lone surrogates is 3. */
function boundedUtf8Prefix(value: string, maximumBytes: number): { text: string; bytes: number } {
  let end = 0, bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > maximumBytes) break;
    bytes += size;
    end += point.length;
  }
  return { text: value.slice(0, end), bytes };
}
