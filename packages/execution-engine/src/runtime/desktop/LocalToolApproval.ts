import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type {
  RuntimeKernelDependencies,
  StartTurnInput,
  WorkerProtocolPort,
} from "@repo/runtime-kernel";
import { createGrantMatcherKey } from "../contracts/RegistryToolAuthorization.js";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];

/** Read canonical approval evidence; workers retain their own root/lease authority. */
export async function assertLocalToolApproved(options: {
  readonly admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
  readonly lifecycleEvents: Pick<
    RuntimeKernelDependencies["lifecycleEvents"],
    "replay"
  >;
  readonly input: ExecutionInput;
  readonly schema: { parse(value: unknown): Record<string, unknown> };
}): Promise<void> {
  const { admission, input, schema } = options;
  const { run, turn, runAttemptId } = admission;
  if (
    turn.runId !== run.id ||
    turn.threadId !== run.threadId ||
    input.runId !== run.id ||
    input.turnId !== turn.id ||
    input.runAttemptId !== runAttemptId ||
    input.workspace.runId !== run.id ||
    input.workspace.workspaceId !== run.workspaceId ||
    input.workspace.permissionProfileId !== run.permissionProfileId ||
    input.workspace.workerId !== run.workerId ||
    input.workspace.executionLocation !== "desktop_local" ||
    run.executionCapability !== "repository" ||
    run.mode === "ask" ||
    run.mode === "review" ||
    run.mode === "plan"
  )
    throw new Error("Local tool identity or permission context changed");
  if (
    !input.approval ||
    input.approval.decision !== "approved" ||
    input.approval.timedOut
  ) {
    throw new Error("Local mutation requires an explicit canonical approval");
  }
  input.signal?.throwIfAborted();
  const parsed = schema.parse(input.toolCall.input);
  const events: LifecycleEvent[] = [];
  const startTypes = ["turn.queued", "turn.started", "run_attempt.started"];
  let afterSequence: number | null = null;
  do {
    input.signal?.throwIfAborted();
    const page = await options.lifecycleEvents.replay({
      turnId: turn.id,
      afterSequence,
      limit: 1_000,
    });
    for (const raw of page.events) {
      const event = LifecycleEventSchema.parse(raw);
      if (
        event.turnId !== turn.id ||
        event.threadId !== run.threadId ||
        event.runAttemptId !== runAttemptId ||
        event.producer.id !== run.workerId ||
        event.sequence !== events.length + 1 ||
        (events.length < startTypes.length &&
          event.type !== startTypes[events.length]) ||
        (events.length >= startTypes.length && startTypes.includes(event.type))
      )
        throw new Error("Approval lifecycle scope or sequence is inconsistent");
      events.push(event);
    }
    if (
      page.nextSequence !== null &&
      (page.events.length === 0 ||
        page.nextSequence !== events.at(-1)?.sequence ||
        page.nextSequence <= (afterSequence ?? 0))
    )
      throw new Error(
        "Approval replay cursor does not advance through canonical events",
      );
    afterSequence = page.nextSequence;
  } while (afterSequence !== null);
  input.signal?.throwIfAborted();
  if (
    events.some(
      (event) =>
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted",
    )
  ) {
    throw new Error("Approval turn is no longer active");
  }
  const tools = events.filter(
    (event) =>
      event.type === "tool_call.started" &&
      event.toolCallId === input.toolCall.toolCallId,
  );
  const tool = tools[0];
  if (
    tools.length !== 1 ||
    tool?.type !== "tool_call.started" ||
    tool.payload.toolName !== input.toolCall.toolName
  ) {
    throw new Error("Canonical tool request is missing or ambiguous");
  }
  const inputs = events.filter(
    (event) =>
      event.type === "tool_call.input_delta" &&
      event.toolCallId === input.toolCall.toolCallId &&
      event.itemId === tool.itemId &&
      event.sequence > tool.sequence &&
      "input" in event.payload,
  );
  const recorded = inputs[0];
  if (
    inputs.length !== 1 ||
    recorded?.type !== "tool_call.input_delta" ||
    JSON.stringify(schema.parse(recorded.payload.input)) !==
      JSON.stringify(parsed)
  ) {
    throw new Error("Approved tool input does not match execution");
  }
  const approvalItems = events.filter(
    (event) =>
      event.type === "item.started" &&
      event.payload.kind === "approval_request" &&
      event.payload.parentItemId === tool.itemId,
  );
  const approvalItem = approvalItems[0];
  if (
    approvalItems.length !== 1 ||
    approvalItem?.type !== "item.started" ||
    approvalItem.sequence <= recorded.sequence
  ) {
    throw new Error("Approval item is missing or ambiguous");
  }
  const requests = events.filter(
    (event) =>
      event.type === "approval.requested" &&
      event.itemId === approvalItem.itemId,
  );
  const request = requests[0];
  if (
    requests.length !== 1 ||
    request?.type !== "approval.requested" ||
    request.sequence <= approvalItem.sequence
  ) {
    throw new Error("Approval request is missing or ambiguous");
  }
  const matcherKey = await createGrantMatcherKey(
    input.toolCall.toolName,
    parsed,
    run,
  );
  const metadata = request.payload.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    metadata.toolName !== input.toolCall.toolName ||
    metadata.permissionProfileId !== run.permissionProfileId ||
    metadata.grantWorkspaceId !== run.workspaceId ||
    metadata.grantMatcherKey !== matcherKey
  )
    throw new Error(
      "Approval policy context does not match the admitted tool request",
    );
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
  )
    throw new Error(
      "Canonical approval receipt does not authorize this active tool request",
    );
  input.signal?.throwIfAborted();
}
