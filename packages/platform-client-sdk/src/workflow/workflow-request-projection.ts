import type {
  ApprovalId,
  ItemId,
  LifecycleEvent,
} from "@repo/platform-protocol";
import type {
  TurnWorkflowProjection,
  WorkflowItem,
  WorkflowApprovalOption,
  WorkflowRequest,
  WorkflowRequestAnswer,
  WorkflowRequestQuestion,
} from "./turn-workflow-projection.js";
import { updateItem, upsertItem } from "./workflow-item-operations.js";

export function requestApproval(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const payload = event.payload;
  const approvalId = requireApprovalId(event);
  const itemId = requireItemId(event);
  const question =
    readString(payload, "question") ??
    readString(payload, "reason") ??
    "Approval requested.";
  const existing = projection.items.find((item) => item.itemId === itemId);
  const requestItem: WorkflowItem = {
    ...emptyWorkflowItem(itemId, event.sequence, event.createdAt),
    ...existing,
    itemId,
    sequence: existing?.sequence ?? event.sequence,
    kind: "approval_request",
    status: "active",
    text: question,
    completedAt: null,
    request: {
      requestId: approvalId,
      questions: [{ id: approvalId, question }],
      answers: [],
      state: "pending",
    },
  };
  return {
    ...upsertItem(projection, requestItem),
    pendingApproval: {
      approvalId,
      itemId,
      question,
      options: readApprovalOptions(payload),
      requestedAt: event.createdAt,
      decidedAt: null,
      decision: null,
    },
    phase: "waiting_for_approval",
  };
}

export function decideApproval(
  projection: TurnWorkflowProjection,
  event: Extract<LifecycleEvent, { type: "approval.decided" }>,
): TurnWorkflowProjection {
  const approvalId = requireApprovalId(event);
  const item = projection.items.find(
    (candidate) =>
      candidate.kind === "approval_request" &&
      candidate.itemId === event.itemId &&
      candidate.request?.requestId === approvalId,
  );
  if (!item) return projection;
  const state = event.payload.status;
  const grantScope = event.payload.grantScope ?? null;
  const answer = approvalDecisionLabel(state, grantScope);
  const request = item.request;
  const settled = updateItem(projection, item.itemId, (current) => ({
    ...current,
    status: state === "approved" ? "completed" : "declined",
    completedAt: event.createdAt,
    request: {
      requestId: approvalId,
      questions: request?.questions ?? [],
      answers: request?.questions.map((question) => ({
        questionId: question.id,
        value: answer,
      })) ?? [{ questionId: approvalId, value: answer }],
      state,
    },
  }));
  const matchingPending = projection.pendingApproval?.approvalId === approvalId;
  return {
    ...settled,
    pendingApproval: matchingPending ? null : settled.pendingApproval,
    phase: matchingPending ? "working" : settled.phase,
  };
}

export function requestUserInput(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const requestId = requireRequestId(event);
  const itemId = requireItemId(event);
  const questions = readRequestQuestions(event.payload);
  const existing = projection.items.find((item) => item.itemId === itemId);
  const prompt = readString(event.payload, "prompt");
  const requestItem: WorkflowItem = {
    ...emptyWorkflowItem(itemId, event.sequence, event.createdAt),
    ...existing,
    itemId,
    sequence: existing?.sequence ?? event.sequence,
    kind: "user_input_request",
    status: "active",
    text:
      questions.map((question) => question.question).join("\n") ||
      prompt ||
      "Input requested.",
    completedAt: null,
    request: {
      requestId,
      questions:
        questions.length > 0
          ? questions
          : [{ id: requestId, question: prompt ?? "Input requested." }],
      answers: [],
      state: "pending",
    },
  };
  return {
    ...upsertItem(projection, requestItem),
    phase: "waiting_for_user_input",
  };
}

export function respondToUserInput(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const requestId = requireRequestId(event);
  const itemId = requireItemId(event);
  const item = projection.items.find(
    (candidate) =>
      candidate.itemId === itemId && candidate.request?.requestId === requestId,
  );
  if (!item?.request || item.kind !== "user_input_request") return projection;
  const answers = readRequestAnswers(event.payload, item.request.questions);
  return {
    ...updateItem(projection, item.itemId, (current) => ({
      ...current,
      status: "completed",
      completedAt: event.createdAt,
      request: { ...item.request!, answers, state: "answered" },
    })),
    phase: "working",
  };
}

export function resolveRequest(
  projection: TurnWorkflowProjection,
  event: LifecycleEvent,
): TurnWorkflowProjection {
  const requestId = requireRequestId(event);
  const itemId = requireItemId(event);
  const item = projection.items.find(
    (candidate) =>
      candidate.itemId === itemId && candidate.request?.requestId === requestId,
  );
  // Permission settlement belongs to approval.decided. A generic request
  // resolution cannot answer an approval or dismiss its actionable dock.
  if (!item?.request || item.kind !== "user_input_request") return projection;
  const status = readString(event.payload, "status");
  const state =
    item.request.state !== "pending"
      ? item.request.state
      : status === "cancelled" || status === "timed_out"
        ? status
        : "resolved";
  return {
    ...updateItem(projection, item.itemId, (current) => ({
      ...current,
      status: current.status === "active" ? "completed" : current.status,
      completedAt: current.completedAt ?? event.createdAt,
      request: { ...item.request!, state },
    })),
    phase: "working",
  };
}

export function cancelPendingRequests(
  items: readonly WorkflowItem[],
  event: LifecycleEvent,
): readonly WorkflowItem[] {
  return items.map((item): WorkflowItem => {
    if (item.request?.state !== "pending") return item;
    return {
      ...item,
      status: "interrupted",
      completedAt: event.createdAt,
      request: { ...item.request, state: "cancelled" },
    };
  });
}

function approvalDecisionLabel(
  state: WorkflowRequest["state"],
  grantScope: string | null,
): string {
  if (state === "approved") {
    return grantScope === "matching_in_chat"
      ? "Accepted for matching actions in this chat"
      : "Accepted";
  }
  if (state === "denied") return "Denied";
  if (state === "timed_out") return "Expired";
  return "Cancelled";
}

function readRequestQuestions(
  payload: Record<string, unknown>,
): WorkflowRequestQuestion[] {
  const value = payload.questions;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const question = readRecord(entry);
    const text = question ? readString(question, "question") : null;
    if (!text) return [];
    return [
      {
        id: (question && readString(question, "id")) ?? `question-${index + 1}`,
        question: text,
      },
    ];
  });
}

function readRequestAnswers(
  payload: Record<string, unknown>,
  questions: readonly WorkflowRequestQuestion[],
): WorkflowRequestAnswer[] {
  const response = readRecord(payload.response) ?? payload;
  const value = response.value;
  if (typeof value === "string" && value.trim()) {
    const questionId = questions[0]?.id;
    return questionId ? [{ questionId, value: value.trim() }] : [];
  }
  const answers = readRecord(response.answers) ?? response;
  if (!answers) return [];
  return questions.flatMap((question) => {
    const answer = answers[question.id];
    const answerRecord = readRecord(answer);
    const answerValues = answerRecord?.answers;
    const resolvedValues =
      typeof answer === "string"
        ? [answer]
        : Array.isArray(answerValues)
          ? answerValues.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
    const resolved = resolvedValues
      .map((entry) => entry.trim())
      .filter(Boolean);
    return resolved.length > 0
      ? [{ questionId: question.id, value: resolved.join("\n") }]
      : [];
  });
}

function emptyWorkflowItem(
  itemId: ItemId,
  sequence: number,
  createdAt: string,
): WorkflowItem {
  return {
    itemId,
    sequence,
    kind: "unknown",
    status: "active",
    text: "",
    detail: null,
    toolFamily: null,
    safeSummary: null,
    inputSummary: null,
    outputSummary: null,
    toolName: null,
    filePath: null,
    command: null,
    outputContent: null,
    diffPreview: null,
    additions: null,
    deletions: null,
    planSteps: [],
    compactionPhase: null,
    startedAt: createdAt,
    completedAt: null,
  };
}

function readApprovalOptions(
  payload: Record<string, unknown>,
): readonly WorkflowApprovalOption[] {
  const value = payload.options;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = readRecord(entry);
    if (
      !option ||
      typeof option.id !== "string" ||
      typeof option.label !== "string" ||
      !(typeof option.description === "string" || option.description === null)
    )
      return [];
    return [
      { id: option.id, label: option.label, description: option.description },
    ];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function requireItemId(event: LifecycleEvent): ItemId {
  if ("itemId" in event && event.itemId) return event.itemId;
  throw new Error(`Lifecycle event ${event.type} is missing itemId.`);
}

function requireApprovalId(event: LifecycleEvent): ApprovalId {
  if ("approvalId" in event) return event.approvalId;
  throw new Error(`Lifecycle event ${event.type} is missing approvalId.`);
}

function requireRequestId(event: LifecycleEvent): string {
  if ("requestId" in event) return event.requestId;
  throw new Error(`Lifecycle event ${event.type} is missing requestId.`);
}
