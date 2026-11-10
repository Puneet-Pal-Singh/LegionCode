import {
  LifecycleEventSchema,
  ToolCallItemContentSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type {
  RuntimeKernelDependencies,
  StartTurnInput,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "@repo/runtime-kernel";
import { createGrantMatcherKey } from "../contracts/RegistryToolAuthorization.js";

type ExecutionInput = Parameters<WorkerProtocolPort["executeTool"]>[0];

/** Read canonical approval evidence; workers retain their own root/lease authority. */
type LocalToolApprovalOptions = {
  readonly admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
  readonly lifecycleEvents: Pick<
    RuntimeKernelDependencies["lifecycleEvents"],
    "replay"
  >;
  readonly input: ExecutionInput;
  readonly schema: { parse(value: unknown): Record<string, unknown> };
};

/** Explicit canonical approval remains mandatory for command execution. */
export async function assertLocalToolApproved(options: LocalToolApprovalOptions): Promise<void> {
  const { admission, input } = options;
  const { run } = admission;
  const { events, tool, recorded, parsed } = await readCanonicalLocalToolRequest(options, true);
  const approval = input.approval;
  if (!approval) throw new Error("Local mutation requires an explicit canonical approval");
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
    decision.payload.decidedBy !== approval.decidedBy ||
    decision.payload.reason !== approval.reason ||
    decision.payload.grantScope !== approval.grantScope ||
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

/** File writes may reuse the same trusted policy owner selected by the kernel.
 * Commands never use this path. No approval record is synthesized or inferred.
 */
export async function assertLocalFileToolAuthorized(
  options: LocalToolApprovalOptions & { readonly toolAuthorization: ToolAuthorizationPort },
): Promise<void> {
  const { admission, input, schema } = options;
  if (input.toolCall.toolName !== "write_file" && input.toolCall.toolName !== "edit_file") {
    throw new Error("Automatic authorization is restricted to canonical file tools");
  }
  if (input.approval !== null) return assertLocalToolApproved(options);
  const { events, tool, parsed } = await readCanonicalLocalToolRequest(options, false);
  const itemStarts = events.filter((event) => event.type === "item.started" && event.itemId === tool.itemId);
  const itemStart = itemStarts[0];
  if (itemStarts.length !== 1 || itemStart?.type !== "item.started" ||
    itemStart.payload.kind !== "tool_call" || itemStart.sequence >= tool.sequence ||
    events.some((event) =>
      ("itemId" in event && event.itemId === tool.itemId &&
        ["item.completed", "item.failed", "item.declined", "item.interrupted"].includes(event.type)) ||
      ("toolCallId" in event && event.toolCallId === input.toolCall.toolCallId &&
        ["tool_call.completed", "tool_call.failed", "tool_call.declined", "tool_call.interrupted"].includes(event.type)))) {
    throw new Error("Canonical file tool request is no longer active");
  }
  const approvalItems = events.filter((event) =>
    event.type === "item.started" && event.payload.kind === "approval_request");
  for (const item of approvalItems) {
    if (item.type !== "item.started") throw new Error("Canonical approval item is invalid");
    const parents = events.filter((event) => event.type === "tool_call.started" &&
      event.itemId === item.payload.parentItemId && event.sequence < item.sequence);
    if (parents.length !== 1 || item.itemId === tool.itemId ||
      item.payload.parentItemId === tool.itemId) {
      throw new Error("A canonical approval item requires its explicit receipt");
    }
  }
  for (const event of events) {
    if (event.type !== "approval.requested" && event.type !== "approval.decided") continue;
    const parents = approvalItems.filter((item) => item.type === "item.started" &&
      item.itemId === event.itemId && item.sequence < event.sequence);
    const parent = parents[0];
    const requests = event.type === "approval.decided" ? events.filter((request) =>
      request.type === "approval.requested" && request.approvalId === event.approvalId &&
      request.itemId === event.itemId && request.sequence < event.sequence) : null;
    if (parents.length !== 1 || parent?.type !== "item.started" ||
      (requests !== null && requests.length !== 1) ||
      parent.payload.parentItemId === tool.itemId || event.itemId === tool.itemId) {
      throw new Error("Canonical approval evidence cannot authorize an automatic file write");
    }
  }
  const toolCall = ToolCallItemContentSchema.parse({ ...input.toolCall, input: parsed });
  const authorization = await options.toolAuthorization.authorize({
    run: admission.run, itemId: tool.itemId, toolCall,
  });
  if (authorization.status !== "authorized" ||
    authorization.toolCall.toolCallId !== toolCall.toolCallId ||
    authorization.toolCall.toolName !== toolCall.toolName ||
    JSON.stringify(schema.parse(authorization.toolCall.input)) !== JSON.stringify(parsed)) {
    throw new Error("The canonical policy does not authorize this exact file tool request");
  }
  input.signal?.throwIfAborted();
}

/** One canonical request reader shared by explicit and policy authorization. */
async function readCanonicalLocalToolRequest(
  options: LocalToolApprovalOptions,
  requireApproval: boolean,
) {
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
    requireApproval && (
      !input.approval ||
      input.approval.decision !== "approved" ||
      input.approval.timedOut
    )
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
  return { events, tool, recorded, parsed };
}
