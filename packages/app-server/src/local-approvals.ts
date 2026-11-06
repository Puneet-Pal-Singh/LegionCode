import type { LocalPersistence } from "@repo/event-store/local";
import {
  SubmitLifecycleApprovalRequestSchema,
  type ApprovalId,
  type ApprovalGrantScope,
  type LifecycleEvent,
  type SubmitLifecycleApprovalRequest,
  type TurnId,
} from "@repo/platform-protocol";
import type { LocalThreadService } from "./local-threads.js";
import { AppServerOperationError } from "./server.js";

/** RuntimeKernel.resolveApproval is the only writer; replay is the receipt. */
export type LocalApprovalServiceOptions = {
  lifecycleEvents: LocalPersistence["lifecycleEvents"];
  threads: Pick<LocalThreadService, "get">;
  resolveApproval: (
    turnId: TurnId,
    approvalId: ApprovalId,
    resolution: {
      decision: SubmitLifecycleApprovalRequest["decision"];
      decidedBy: SubmitLifecycleApprovalRequest["decidedBy"];
      reason: SubmitLifecycleApprovalRequest["reason"];
      grantScope?: ApprovalGrantScope;
    },
  ) => Promise<void>;
};

type DecisionEvent = Extract<LifecycleEvent, { type: "approval.decided" }>;

export class LocalApprovalService {
  // Serialize commands, not lifecycle state. All decisions are read from replay.
  private readonly commands = new Map<TurnId, Promise<unknown>>();

  constructor(private readonly options: LocalApprovalServiceOptions) {}

  async submitLifecycleApproval(input: unknown): Promise<LifecycleEvent> {
    const request = SubmitLifecycleApprovalRequestSchema.parse(input);
    if (request.backend !== undefined) {
      throw new AppServerOperationError(
        400,
        "invalid_request",
        "Local approvals do not accept a hosted backend",
      );
    }
    const previous = this.commands.get(request.turnId) ?? Promise.resolve();
    const command = previous
      .catch(() => undefined)
      .then(() => this.submit(request));
    this.commands.set(request.turnId, command);
    try {
      return await command;
    } finally {
      if (this.commands.get(request.turnId) === command)
        this.commands.delete(request.turnId);
    }
  }

  private async submit(
    request: SubmitLifecycleApprovalRequest,
  ): Promise<DecisionEvent> {
    const events = await this.replay(request.turnId);
    const requested = events.filter(
      (event) =>
        event.type === "approval.requested" &&
        event.approvalId === request.approvalId,
    );
    if (requested.length !== 1)
      throw conflict("Approval request is missing or ambiguous");
    const approval = requested[0]!;
    if (approval.type !== "approval.requested")
      throw conflict("Approval request is missing");
    // LocalThreadService validates the thread against the current ready grant.
    const thread = await this.options.threads.get(approval.threadId);
    if (request.decidedBy !== null && request.decidedBy !== thread.userId) {
      throw new AppServerOperationError(
        403,
        "forbidden",
        "Approval decision belongs to another local user",
      );
    }
    if (events.some((event) => event.threadId !== thread.id))
      throw conflict("Approval thread identity changed");
    const item = events.find(
      (event) =>
        event.type === "item.started" && event.itemId === approval.itemId,
    );
    const parent =
      item?.type === "item.started" && item.payload.kind === "approval_request"
        ? item.payload.parentItemId
        : undefined;
    const tool = events.find(
      (event) =>
        event.type === "tool_call.started" &&
        event.itemId === parent &&
        event.runAttemptId === approval.runAttemptId,
    );
    if (
      !tool ||
      tool.type !== "tool_call.started" ||
      item?.runAttemptId !== approval.runAttemptId ||
      tool.sequence >= approval.sequence ||
      item.sequence >= approval.sequence
    ) {
      throw conflict(
        "Approval is not bound to a tool request in its run attempt",
      );
    }
    const decided = events.find(
      (event) =>
        event.type === "approval.decided" &&
        event.approvalId === request.approvalId,
    );
    if (decided?.type === "approval.decided") {
      if (
        decided.runAttemptId !== approval.runAttemptId ||
        decided.itemId !== approval.itemId
      ) {
        throw conflict("Approval decision identity does not match its request");
      }
      return this.receipt(decided, request);
    }
    if (
      events.at(-1)?.runAttemptId !== approval.runAttemptId ||
      events.some(
        (event) =>
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted" ||
          (event.runAttemptId === approval.runAttemptId &&
            (event.type === "run_attempt.succeeded" ||
              event.type === "run_attempt.failed" ||
              event.type === "run_attempt.interrupted")) ||
          ("toolCallId" in event &&
            event.toolCallId === tool.toolCallId &&
            (event.type === "tool_call.completed" ||
              event.type === "tool_call.failed" ||
              event.type === "tool_call.declined" ||
              event.type === "tool_call.interrupted")),
      )
    )
      throw conflict("Approval is no longer active");
    if (
      request.grantScope === "matching_in_chat" &&
      request.decision !== "approved"
    ) {
      throw conflict("A reusable approval scope requires an approved decision");
    }
    await this.options.resolveApproval(request.turnId, request.approvalId, {
      decision: request.decision,
      decidedBy: request.decidedBy,
      reason: request.reason,
      ...(request.grantScope === "matching_in_chat"
        ? { grantScope: request.grantScope }
        : {}),
    });
    const settled = (await this.replay(request.turnId)).find(
      (event) =>
        event.type === "approval.decided" &&
        event.approvalId === request.approvalId,
    );
    if (
      settled?.type !== "approval.decided" ||
      settled.runAttemptId !== approval.runAttemptId ||
      settled.itemId !== approval.itemId
    ) {
      throw conflict("Runtime has not recorded this approval decision");
    }
    return this.receipt(settled, request);
  }

  private receipt(
    event: DecisionEvent,
    request: SubmitLifecycleApprovalRequest,
  ): DecisionEvent {
    const scope =
      request.grantScope === "matching_in_chat"
        ? request.grantScope
        : undefined;
    if (
      event.payload.status !== request.decision ||
      event.payload.grantScope !== scope ||
      event.payload.decidedBy !== request.decidedBy ||
      event.payload.reason !== request.reason
    ) {
      throw conflict("Approval already has a different decision");
    }
    return event;
  }

  private async replay(turnId: TurnId): Promise<LifecycleEvent[]> {
    const events: LifecycleEvent[] = [];
    let afterSequence: number | null = null;
    do {
      const page = await this.options.lifecycleEvents.replay({
        turnId,
        afterSequence,
        limit: 1_000,
      });
      events.push(...page.events);
      afterSequence = page.nextSequence;
    } while (afterSequence !== null);
    return events;
  }
}

function conflict(message: string): AppServerOperationError {
  return new AppServerOperationError(
    409,
    "conflict",
    message,
    "local_approval_conflict",
  );
}
