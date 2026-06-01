import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ApprovalResolutionStatus,
  RunEvent,
  RunWorkflowStep,
} from "@repo/shared-types";
import type { RunStatus, SerializedTask } from "../types.js";
import {
  DEFAULT_ASSISTANT_FINAL_TRANSCRIPT,
  DEFAULT_USER_PROMPT_TRANSCRIPT,
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createMessageEmittedEvent,
  createRunCompletedEvent,
  createRunFailedEvent,
  createRunProgressEvent,
  createRunStartedEvent,
  createRunStatusChangedEvent,
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolOutputAppendedEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  mapRuntimeStatusToRunEventStatus,
  toToolEventInput,
} from "./RunEventFactory.js";
import { RunEventRepository } from "./RunEventRepository.js";

export class RunEventRecorder {
  constructor(
    private readonly repository: RunEventRepository,
    private readonly runId: string,
    private readonly sessionId: string,
    private readonly eventListener?: (event: RunEvent) => Promise<void> | void,
  ) {}

  async ensureRunStarted(status: RunStatus): Promise<void> {
    const existingEvents = await this.repository.getByRun(this.runId);
    if (existingEvents.length > 0) {
      return;
    }

    await this.append(
      createRunStartedEvent(
        this.baseInput(),
        status === "RUNNING" ? "running" : "queued",
      ),
    );
  }

  async recordRunStatusChanged(
    previousStatus: RunStatus,
    newStatus: RunStatus,
    workflowStep?: RunWorkflowStep,
    reason?: string,
  ): Promise<void> {
    if (previousStatus === newStatus && !workflowStep) {
      return;
    }

    await this.append(
      createRunStatusChangedEvent(
        this.baseInput(),
        mapRuntimeStatusToRunEventStatus(previousStatus),
        mapRuntimeStatusToRunEventStatus(newStatus),
        workflowStep,
        reason,
      ),
    );
  }

  async recordRunProgress(
    phase: RunWorkflowStep,
    label: string,
    summary: string,
    status: "active" | "completed",
    options?: {
      displayMode?: "visible" | "collapsed" | "debug";
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.append(
      createRunProgressEvent(
        this.baseInput(),
        phase,
        label,
        summary,
        status,
        options,
      ),
    );
  }

  async recordApprovalRequested(request: ApprovalRequest): Promise<void> {
    await this.append(createApprovalRequestedEvent(this.baseInput(), request));
  }

  async recordApprovalResolved(input: {
    requestId: string;
    decision: ApprovalDecisionKind;
    status: ApprovalResolutionStatus;
    resolvedAt?: string;
  }): Promise<void> {
    await this.append(createApprovalResolvedEvent(this.baseInput(), input));
  }

  async recordApprovalResolvedIfNotExists(input: {
    requestId: string;
    decision: ApprovalDecisionKind;
    status: ApprovalResolutionStatus;
    resolvedAt?: string;
  }): Promise<boolean> {
    const event = createApprovalResolvedEvent(this.baseInput(), input);
    const inserted = await this.repository.appendApprovalResolvedIfMissing(
      this.runId,
      event,
    );
    if (!inserted || !this.eventListener) {
      return inserted;
    }

    try {
      await this.eventListener(event);
    } catch (error) {
      console.warn("[run/events] failed to emit live run event", error);
    }

    return inserted;
  }

  async recordToolRequested(
    task: Pick<SerializedTask, "id" | "type"> & {
      input?: Record<string, unknown>;
    },
  ): Promise<void> {
    const presentation = extractToolRequestedPresentation(task.input);
    await this.append(
      createToolRequestedEvent(
        toToolEventInput(this.runId, this.sessionId, task),
        sanitizeEventArguments(task.input),
        presentation,
      ),
    );
  }

  async recordToolStarted(task: Pick<SerializedTask, "id" | "type">) {
    await this.append(
      createToolStartedEvent(
        toToolEventInput(this.runId, this.sessionId, task),
      ),
    );
  }

  async recordToolOutputAppended(
    task: Pick<SerializedTask, "id" | "type">,
    chunk: {
      stdoutDelta?: string;
      stderrDelta?: string;
      turnId?: string;
      truncated?: boolean;
    },
  ): Promise<void> {
    await this.append(
      createToolOutputAppendedEvent(
        toToolEventInput(this.runId, this.sessionId, task),
        chunk,
      ),
    );
  }

  async recordToolCompleted(
    task: Pick<SerializedTask, "id" | "type">,
    result: unknown,
    executionTimeMs: number,
  ): Promise<void> {
    await this.append(
      createToolCompletedEvent(
        toToolEventInput(this.runId, this.sessionId, task),
        result,
        executionTimeMs,
      ),
    );
  }

  async recordToolFailed(
    task: Pick<SerializedTask, "id" | "type">,
    error: string,
    executionTimeMs: number,
  ): Promise<void> {
    await this.append(
      createToolFailedEvent(
        toToolEventInput(this.runId, this.sessionId, task),
        error,
        executionTimeMs,
      ),
    );
  }

  async recordMessageEmitted(
    role: "user" | "assistant" | "system",
    content: string,
    metadata?: Record<string, unknown>,
    transcript?: {
      phase?: "prompt" | "commentary" | "final_answer";
      status?: "active" | "completed";
    },
  ): Promise<void> {
    if (!content.trim()) {
      return;
    }

    const normalizedTranscript =
      transcript ??
      (role === "user"
        ? DEFAULT_USER_PROMPT_TRANSCRIPT
        : role === "assistant"
          ? DEFAULT_ASSISTANT_FINAL_TRANSCRIPT
          : undefined);

    await this.append(
      createMessageEmittedEvent(
        this.baseInput(),
        content,
        role,
        metadata,
        normalizedTranscript,
      ),
    );
  }

  async recordRunCompleted(
    totalDurationMs: number,
    toolsUsed: number,
  ): Promise<void> {
    await this.append(
      createRunCompletedEvent(this.baseInput(), totalDurationMs, toolsUsed),
    );
  }

  async recordRunFailed(error: string, totalDurationMs: number): Promise<void> {
    await this.append(
      createRunFailedEvent(this.baseInput(), error, totalDurationMs),
    );
  }

  async clear(): Promise<void> {
    await this.repository.clear(this.runId);
  }

  private baseInput() {
    return {
      runId: this.runId,
      sessionId: this.sessionId,
    };
  }

  private async append(event: RunEvent): Promise<void> {
    await this.repository.append(this.runId, event);
    if (!this.eventListener) {
      return;
    }

    try {
      await this.eventListener(event);
    } catch (error) {
      console.warn("[run/events] failed to emit live run event", error);
    }
  }
}

function sanitizeEventArguments(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) {
    return {};
  }

  const args: Record<string, unknown> = { ...input };
  delete args.description;
  delete args.expectedOutput;
  delete args.displayText;
  return args;
}

function extractToolRequestedPresentation(
  input: Record<string, unknown> | undefined,
): { description?: string; displayText?: string } | undefined {
  if (!input) {
    return undefined;
  }

  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : undefined;
  const displayText =
    typeof input.displayText === "string" && input.displayText.trim()
      ? input.displayText.trim()
      : undefined;

  if (!description && !displayText) {
    return undefined;
  }

  return { description, displayText };
}
