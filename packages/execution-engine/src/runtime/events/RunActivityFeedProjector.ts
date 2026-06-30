import {
  safeParseToolActivityMetadata,
  ACTIVITY_PART_KINDS,
  COMMENTARY_ACTIVITY_PHASES,
  COMMENTARY_ACTIVITY_STATUSES,
  MESSAGE_TRANSCRIPT_PHASES,
  REASONING_ACTIVITY_STATUSES,
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  TOOL_ACTIVITY_FAMILIES,
  TOOL_ACTIVITY_STATUSES,
  type ActivityFeedSnapshot,
  type ActivityPart,
  type ApprovalActivityPart,
  type CommentaryActivityPart,
  type ReasoningActivityPart,
  type RunEvent,
  type ToolActivityMetadata,
  type ToolActivityPart,
} from "@repo/shared-types";
import type { SerializedRun } from "../types.js";
import { getToolPresentation } from "../lib/ToolPresentation.js";

const UNKNOWN_ACTIVITY_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const SHELL_OUTPUT_TAIL_CAP = 128 * 1024;
const SHELL_STREAM_CAP_PER_CHANNEL = SHELL_OUTPUT_TAIL_CAP / 2;

interface ProjectRunActivityFeedParams {
  runId: string;
  run: Pick<SerializedRun, "id" | "sessionId" | "status" | "metadata"> | null;
  events: RunEvent[];
}

export function projectRunActivityFeed(
  params: ProjectRunActivityFeedParams,
): ActivityFeedSnapshot {
  const { runId, run } = params;
  const events = [...params.events].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const items: ActivityPart[] = [];
  const toolParts = new Map<string, ToolActivityPart>();
  const approvalParts = new Map<string, ApprovalActivityPart>();
  let turnIndex = 0;
  let currentTurnId: string | undefined;

  for (const event of events) {
    currentTurnId = updateTurnId(currentTurnId, event, () => {
      turnIndex += 1;
      return `turn-${turnIndex}`;
    });

    switch (event.type) {
      case RUN_EVENT_TYPES.MESSAGE_EMITTED: {
        const part = createMessagePart(event, currentTurnId);
        if (part) {
          items.push(part);
        }
        break;
      }
      case RUN_EVENT_TYPES.RUN_STATUS_CHANGED: {
        const part = createReasoningPart(event, currentTurnId);
        if (part) {
          items.push(part);
        }
        break;
      }
      case RUN_EVENT_TYPES.RUN_PROGRESS:
        items.push(createProgressPart(event, currentTurnId));
        break;
      case RUN_EVENT_TYPES.APPROVAL_REQUESTED: {
        const part = createApprovalRequestedPart(event, currentTurnId);
        approvalParts.set(event.payload.request.requestId, part);
        items.push(part);
        break;
      }
      case RUN_EVENT_TYPES.APPROVAL_RESOLVED:
        applyApprovalResolution(approvalParts, event);
        break;
      case RUN_EVENT_TYPES.TOOL_REQUESTED: {
        const part = createRequestedToolPart(event, currentTurnId);
        toolParts.set(part.toolId, part);
        items.push(part);
        break;
      }
      case RUN_EVENT_TYPES.TOOL_STARTED:
        updateToolPart(toolParts, event.payload.toolId, {
          status: TOOL_ACTIVITY_STATUSES.RUNNING,
          updatedAt: event.timestamp,
          startedAt: event.timestamp,
        });
        break;
      case RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED:
        appendToolOutput(toolParts, event);
        break;
      case RUN_EVENT_TYPES.TOOL_COMPLETED:
        applyToolCompletion(toolParts, event);
        break;
      case RUN_EVENT_TYPES.TOOL_FAILED:
        applyToolFailure(toolParts, event);
        break;
      default:
        break;
    }
  }

  if (approvalParts.size === 0) {
    items.push(...createApprovalParts(run, currentTurnId));
  }
  return {
    runId,
    sessionId: run?.sessionId,
    status: resolveActivityFeedStatus(events, run?.status ?? null),
    items: items.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  };
}

function resolveActivityFeedStatus(
  events: RunEvent[],
  fallbackStatus: string | null,
): ActivityFeedSnapshot["status"] {
  const latestLifecycleEvent = [...events]
    .reverse()
    .find(isRunLifecycleEvent);
  const latestOpenActivityEvent = [...events].reverse().find(isOpenActivityEvent);
  const fallbackActivityStatus = mapCanonicalRunStatus(fallbackStatus);
  if (
    latestOpenActivityEvent &&
    (!latestLifecycleEvent ||
      latestOpenActivityEvent.timestamp > latestLifecycleEvent.timestamp)
  ) {
    if (!latestLifecycleEvent && isTerminalActivityStatus(fallbackActivityStatus)) {
      return fallbackActivityStatus;
    }
    return "RUNNING";
  }
  if (latestLifecycleEvent?.type === RUN_EVENT_TYPES.RUN_COMPLETED) {
    return "COMPLETED";
  }
  if (latestLifecycleEvent?.type === RUN_EVENT_TYPES.RUN_FAILED) {
    return "FAILED";
  }
  if (latestLifecycleEvent?.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED) {
    return mapCanonicalRunStatus(latestLifecycleEvent.payload.newStatus);
  }
  if (latestLifecycleEvent?.type === RUN_EVENT_TYPES.RUN_STARTED) {
    return "RUNNING";
  }
  if (isTerminalActivityStatus(fallbackActivityStatus)) {
    return fallbackActivityStatus;
  }
  if (events.some(isOpenActivityEvent)) {
    return "RUNNING";
  }
  return fallbackActivityStatus;
}

function isRunLifecycleEvent(event: RunEvent): boolean {
  return (
    event.type === RUN_EVENT_TYPES.RUN_STARTED ||
    event.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED ||
    event.type === RUN_EVENT_TYPES.RUN_COMPLETED ||
    event.type === RUN_EVENT_TYPES.RUN_FAILED
  );
}

function isOpenActivityEvent(event: RunEvent): boolean {
  switch (event.type) {
    case RUN_EVENT_TYPES.MESSAGE_EMITTED:
      return event.payload.role === "user";
    case RUN_EVENT_TYPES.RUN_PROGRESS:
      return event.payload.status === "active";
    case RUN_EVENT_TYPES.APPROVAL_REQUESTED:
    case RUN_EVENT_TYPES.TOOL_REQUESTED:
    case RUN_EVENT_TYPES.TOOL_STARTED:
    case RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED:
      return true;
    default:
      return false;
  }
}

function mapCanonicalRunStatus(
  status: string | null,
): ActivityFeedSnapshot["status"] {
  switch (status) {
    case "complete":
    case "completed":
    case "COMPLETED":
      return "COMPLETED";
    case "failed":
    case "FAILED":
    case "cancelled":
    case "CANCELLED":
      return "FAILED";
    case "queued":
    case "running":
    case "waiting":
    case "paused":
    case "CREATED":
    case "RUNNING":
    case "PAUSED":
      return "RUNNING";
    default:
      return null;
  }
}

function isTerminalActivityStatus(
  status: ActivityFeedSnapshot["status"],
): status is "COMPLETED" | "FAILED" {
  return status === "COMPLETED" || status === "FAILED";
}

function updateTurnId(
  currentTurnId: string | undefined,
  event: RunEvent,
  createTurnId: () => string,
): string | undefined {
  if (
    event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED &&
    event.payload.role === "user"
  ) {
    return readClientMessageId(event.payload.metadata) ?? createTurnId();
  }
  return currentTurnId;
}

function readClientMessageId(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createMessagePart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
  turnId: string | undefined,
): ActivityPart | null {
  const commentaryPart = createCommentaryPart(event, turnId);
  if (commentaryPart) {
    return commentaryPart;
  }

  return {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.TEXT,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    role: event.payload.role,
    content: event.payload.content,
    metadata: event.payload.metadata,
  };
}

function createCommentaryPart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
  turnId: string | undefined,
): CommentaryActivityPart | null {
  if (!shouldProjectCommentary(event)) {
    return null;
  }

  return {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.COMMENTARY,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    phase: mapTranscriptPhaseToCommentaryPhase(event.payload.transcriptPhase),
    status:
      event.payload.transcriptStatus ?? COMMENTARY_ACTIVITY_STATUSES.COMPLETED,
    text: event.payload.content,
    metadata: event.payload.metadata,
  };
}

function createReasoningPart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.RUN_STATUS_CHANGED }>,
  turnId: string | undefined,
): ReasoningActivityPart | null {
  const workflowStep = event.payload.workflowStep;
  if (!workflowStep || workflowStep !== RUN_WORKFLOW_STEPS.PLANNING) {
    return null;
  }

  return {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.REASONING,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    label: getReasoningLabel(workflowStep),
    summary: event.payload.reason?.trim() || getReasoningSummary(workflowStep),
    phase: workflowStep,
    status: REASONING_ACTIVITY_STATUSES.COMPLETED,
  };
}

function createProgressPart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.RUN_PROGRESS }>,
  turnId: string | undefined,
): ReasoningActivityPart {
  return {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.REASONING,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    label: event.payload.label,
    summary: event.payload.summary,
    phase: event.payload.phase,
    status: event.payload.status,
  };
}

function shouldProjectCommentary(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }>,
): boolean {
  if (event.payload.role !== "assistant") {
    return false;
  }

  if (
    event.payload.transcriptPhase === MESSAGE_TRANSCRIPT_PHASES.COMMENTARY ||
    event.payload.transcriptPhase === MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER
  ) {
    return true;
  }

  return isRecoveryMessage(event.payload.metadata);
}

function mapTranscriptPhaseToCommentaryPhase(
  phase: Extract<
    RunEvent,
    { type: typeof RUN_EVENT_TYPES.MESSAGE_EMITTED }
  >["payload"]["transcriptPhase"],
): CommentaryActivityPart["phase"] {
  return phase === MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER
    ? COMMENTARY_ACTIVITY_PHASES.FINAL_ANSWER
    : COMMENTARY_ACTIVITY_PHASES.COMMENTARY;
}

function isRecoveryMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const code = typeof metadata?.code === "string" ? metadata.code : undefined;
  return (
    code === "PROVIDER_UNAVAILABLE" ||
    code === "TASK_EXECUTION_TIMEOUT" ||
    code === "TASK_MODEL_NO_ACTION"
  );
}

function createRequestedToolPart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_REQUESTED }>,
  turnId: string | undefined,
): ToolActivityPart {
  return {
    id: event.eventId,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.TOOL,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    toolId: event.payload.toolId,
    toolName: event.payload.toolName,
    status: TOOL_ACTIVITY_STATUSES.REQUESTED,
    input: event.payload.arguments,
    metadata: buildToolMetadata(
      event.payload.toolName,
      event.payload.arguments,
      event.payload.description,
      event.payload.displayText,
      undefined,
      undefined,
    ),
  };
}

function applyToolCompletion(
  toolParts: Map<string, ToolActivityPart>,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_COMPLETED }>,
): void {
  const part = toolParts.get(event.payload.toolId);
  if (!part) {
    return;
  }
  part.status = TOOL_ACTIVITY_STATUSES.COMPLETED;
  part.updatedAt = event.timestamp;
  part.startedAt = part.startedAt ?? event.timestamp;
  part.endedAt = event.timestamp;
  part.output = event.payload.result;
  part.metadata = mergeToolMetadata(
    part.metadata,
    buildToolMetadata(
      part.toolName,
      part.input,
      readToolMetadataDescription(part.metadata),
      readToolMetadataDisplayText(part.metadata),
      event.payload.result,
      undefined,
    ),
  );
}

function applyToolFailure(
  toolParts: Map<string, ToolActivityPart>,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.TOOL_FAILED }>,
): void {
  const part = toolParts.get(event.payload.toolId);
  if (!part) {
    return;
  }
  part.status = TOOL_ACTIVITY_STATUSES.FAILED;
  part.updatedAt = event.timestamp;
  part.startedAt = part.startedAt ?? event.timestamp;
  part.endedAt = event.timestamp;
  part.output = { error: event.payload.error };
  part.metadata = mergeToolMetadata(
    part.metadata,
    buildToolMetadata(
      part.toolName,
      part.input,
      readToolMetadataDescription(part.metadata),
      readToolMetadataDisplayText(part.metadata),
      undefined,
      event.payload.error,
    ),
  );
}

function appendToolOutput(
  toolParts: Map<string, ToolActivityPart>,
  event: Extract<
    RunEvent,
    { type: typeof RUN_EVENT_TYPES.TOOL_OUTPUT_APPENDED }
  >,
): void {
  const part = toolParts.get(event.payload.toolId);
  if (!part || part.metadata.family !== TOOL_ACTIVITY_FAMILIES.SHELL) {
    return;
  }

  const nextStdout = appendCappedText(
    part.metadata.stdout,
    event.payload.stdoutDelta,
    SHELL_STREAM_CAP_PER_CHANNEL,
  );
  const nextStderr = appendCappedText(
    part.metadata.stderr,
    event.payload.stderrDelta,
    SHELL_STREAM_CAP_PER_CHANNEL,
  );

  part.status = TOOL_ACTIVITY_STATUSES.RUNNING;
  part.updatedAt = event.timestamp;
  part.startedAt = part.startedAt ?? event.timestamp;
  part.metadata = {
    ...part.metadata,
    stdout: nextStdout.value || undefined,
    stderr: nextStderr.value || undefined,
    outputTail:
      buildShellOutputTail(nextStdout.value, nextStderr.value) || undefined,
    truncated:
      part.metadata.truncated ||
      nextStdout.truncated ||
      nextStderr.truncated ||
      Boolean(event.payload.truncated),
  };
}

function updateToolPart(
  toolParts: Map<string, ToolActivityPart>,
  toolId: string,
  patch: Partial<ToolActivityPart>,
): void {
  const part = toolParts.get(toolId);
  if (!part) {
    return;
  }
  Object.assign(part, patch);
}

function createApprovalRequestedPart(
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.APPROVAL_REQUESTED }>,
  turnId: string | undefined,
): ApprovalActivityPart {
  return {
    id: `approval:${event.payload.request.requestId}`,
    runId: event.runId,
    sessionId: event.sessionId,
    turnId,
    kind: ACTIVITY_PART_KINDS.APPROVAL,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    approvalType: "permission",
    status: "requested",
    summary: event.payload.request.title,
    details: buildApprovalDetails(
      event.payload.request.reason,
      event.payload.request.command,
    ),
    expiresAt: event.payload.request.expiresAt,
  };
}

function applyApprovalResolution(
  approvalParts: Map<string, ApprovalActivityPart>,
  event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.APPROVAL_RESOLVED }>,
): void {
  const part = approvalParts.get(event.payload.requestId);
  const decisionDetail = `Decision: ${event.payload.decision}`;
  if (part) {
    part.status = mapApprovalResolutionStatus(event.payload.status);
    part.updatedAt = event.timestamp;
    part.summary = buildApprovalResolutionSummary(event.payload.status);
    part.details = appendApprovalDecisionDetail(part.details, decisionDetail);
    return;
  }

  approvalParts.set(event.payload.requestId, {
    id: `approval:${event.payload.requestId}`,
    runId: event.runId,
    sessionId: event.sessionId,
    kind: ACTIVITY_PART_KINDS.APPROVAL,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    source: event.source,
    approvalType: "permission",
    status: mapApprovalResolutionStatus(event.payload.status),
    summary: buildApprovalResolutionSummary(event.payload.status),
    details: decisionDetail,
  });
}

function mapApprovalResolutionStatus(
  status: Extract<
    RunEvent,
    { type: typeof RUN_EVENT_TYPES.APPROVAL_RESOLVED }
  >["payload"]["status"],
): ApprovalActivityPart["status"] {
  if (status === "approved") {
    return "granted";
  }
  if (status === "aborted") {
    return "denied";
  }
  if (status === "expired") {
    return "expired";
  }
  return "denied";
}

function buildApprovalResolutionSummary(
  status: Extract<
    RunEvent,
    { type: typeof RUN_EVENT_TYPES.APPROVAL_RESOLVED }
  >["payload"]["status"],
): string {
  if (status === "approved") {
    return "Approval resolved";
  }
  if (status === "expired") {
    return "Approval expired";
  }
  if (status === "aborted") {
    return "Approval cancelled";
  }
  return "Approval denied";
}

function appendApprovalDecisionDetail(
  currentDetails: string | undefined,
  decisionDetail: string,
): string {
  if (!currentDetails) {
    return decisionDetail;
  }
  if (currentDetails.includes(decisionDetail)) {
    return currentDetails;
  }
  return `${currentDetails}\n${decisionDetail}`;
}

function buildApprovalDetails(reason: string, command?: string): string {
  if (!command) {
    return reason;
  }
  return `${reason}\nCommand: ${command}`;
}

function createApprovalParts(
  run: Pick<SerializedRun, "id" | "sessionId" | "status" | "metadata"> | null,
  turnId: string | undefined,
): ApprovalActivityPart[] {
  const steps = run?.metadata.lifecycleSteps ?? [];
  return steps
    .filter((step) => step.step === "APPROVAL_WAIT")
    .map((step, index) => ({
      id: `${run?.id ?? "run"}:approval:${index}`,
      runId: run?.id ?? "",
      sessionId: run?.sessionId,
      turnId,
      kind: ACTIVITY_PART_KINDS.APPROVAL,
      createdAt: step.recordedAt,
      updatedAt: step.recordedAt,
      source: "brain",
      approvalType: inferApprovalType(step.detail),
      status: "requested",
      summary: inferApprovalSummary(step.detail),
      details: step.detail,
    }));
}

function buildToolMetadata(
  toolName: string,
  input: Record<string, unknown> | undefined,
  description: string | undefined,
  displayText: string | undefined,
  result: unknown,
  error: string | undefined,
): ToolActivityMetadata {
  const metadataFromResult = getStructuredActivityMetadata(result);
  if (metadataFromResult) {
    return metadataFromResult;
  }

  const outputText = getResultContent(result);
  const toolPresentation = getToolPresentation(toolName, input);
  switch (toolName) {
    case "read_file":
      return buildReadMetadata(
        input,
        outputText,
        displayText ?? toolPresentation.displayText,
      );
    case "list_files":
      return buildListMetadata(
        input,
        outputText,
        displayText ?? toolPresentation.displayText,
      );
    case "glob":
    case "grep":
      return buildSearchMetadata(
        toolName,
        input,
        outputText,
        displayText ?? toolPresentation.displayText,
      );
    case "bash":
      return {
        family: TOOL_ACTIVITY_FAMILIES.SHELL,
        displayText: displayText ?? toolPresentation.displayText ?? undefined,
        command: readString(input?.command) ?? toolName,
        description: description ?? toolPresentation.description,
        cwd: readString(input?.cwd) ?? ".",
        origin: "agent_tool",
        stdout: outputText || undefined,
        stderr: error,
        outputTail: buildShellOutputTail(outputText, error ?? "") || undefined,
        exitCode: error ? 1 : 0,
        truncated: false,
      };
    case "write_file":
      return {
        family: TOOL_ACTIVITY_FAMILIES.EDIT,
        displayText: displayText ?? toolPresentation.displayText ?? undefined,
        filePath: readString(input?.path) ?? "unknown",
        additions: 0,
        deletions: 0,
        diffPreview: outputText || undefined,
      };
    case "git_stage":
    case "git_commit":
    case "git_push":
    case "git_pull":
    case "git_create_pull_request":
    case "git_branch_create":
    case "git_branch_switch":
    case "git_status":
    case "git_diff":
    case "github_pr_list":
    case "github_pr_get":
    case "github_pr_checks_get":
    case "github_review_threads_get":
    case "github_issue_get":
    case "github_actions_run_get":
    case "github_actions_job_logs_get":
      return buildGitMetadata(
        input,
        outputText,
        displayText ?? toolPresentation.displayText,
      );
    default:
      return {
        family: TOOL_ACTIVITY_FAMILIES.GENERIC,
        displayText: displayText ?? toolPresentation.displayText ?? undefined,
        summary: outputText || error || undefined,
      };
  }
}

function mergeToolMetadata(
  current: ToolActivityMetadata,
  next: ToolActivityMetadata,
): ToolActivityMetadata {
  const nextDisplayText =
    readToolMetadataDisplayText(next) ?? readToolMetadataDisplayText(current);

  if (
    current.family !== TOOL_ACTIVITY_FAMILIES.SHELL ||
    next.family !== TOOL_ACTIVITY_FAMILIES.SHELL
  ) {
    return nextDisplayText ? { ...next, displayText: nextDisplayText } : next;
  }

  const stdout = next.stdout ?? current.stdout;
  const stderr = next.stderr ?? current.stderr;
  return {
    ...current,
    ...next,
    displayText: nextDisplayText,
    description: next.description ?? current.description,
    stdout,
    stderr,
    outputTail: buildShellOutputTail(stdout ?? "", stderr ?? "") || undefined,
    truncated: current.truncated || next.truncated,
  };
}

function getStructuredActivityMetadata(
  result: unknown,
): ToolActivityMetadata | null {
  const activity = getActivityMetadata(result);
  const parsed = safeParseToolActivityMetadata(activity);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function getActivityMetadata(result: unknown): unknown {
  if (!isRecord(result)) {
    return null;
  }

  const metadata = isRecord(result.metadata) ? result.metadata : null;
  if (metadata && isRecord(metadata.activity)) {
    return metadata.activity;
  }

  const output = isRecord(result.output) ? result.output : null;
  const outputMetadata =
    output && isRecord(output.metadata) ? output.metadata : null;
  return outputMetadata?.activity ?? null;
}

function getResultContent(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (isRecord(result) && typeof result.content === "string") {
    return result.content;
  }
  return "";
}

function buildReadMetadata(
  input: Record<string, unknown> | undefined,
  outputText: string,
  displayText: string | undefined,
): ToolActivityMetadata {
  const path = readString(input?.path);
  return {
    family: TOOL_ACTIVITY_FAMILIES.READ,
    displayText:
      displayText ?? getToolPresentation("read_file", input).displayText,
    path,
    count: path ? 1 : 0,
    truncated: outputText.length > 240,
    preview: truncateText(outputText, 240) || undefined,
    loadedPaths: path ? [path] : [],
  };
}

function buildListMetadata(
  input: Record<string, unknown> | undefined,
  outputText: string,
  displayText: string | undefined,
): ToolActivityMetadata {
  const path = readString(input?.path);
  const lines = splitNonEmptyLines(outputText);
  return {
    family: TOOL_ACTIVITY_FAMILIES.READ,
    displayText:
      displayText ?? getToolPresentation("list_files", input).displayText,
    path: path ?? ".",
    count: lines.length,
    truncated: /\.\.\. and \d+ more files/i.test(outputText),
    preview: truncateText(lines.slice(0, 6).join("\n"), 240) || undefined,
    loadedPaths: path ? [path] : [],
  };
}

function buildSearchMetadata(
  toolName: string,
  input: Record<string, unknown> | undefined,
  outputText: string,
  displayText: string | undefined,
): ToolActivityMetadata {
  const lines = splitNonEmptyLines(outputText);
  const loadedPaths =
    toolName === "grep"
      ? Array.from(
          new Set(
            lines
              .map((line) => line.split(":")[0]?.trim())
              .filter((line): line is string => Boolean(line)),
          ),
        )
      : lines;
  return {
    family: TOOL_ACTIVITY_FAMILIES.SEARCH,
    displayText:
      displayText ?? getToolPresentation(toolName, input).displayText,
    path: readString(input?.path) ?? ".",
    pattern: readString(input?.pattern),
    count: lines.length,
    truncated: false,
    preview: truncateText(lines.slice(0, 6).join("\n"), 240) || undefined,
    loadedPaths,
  };
}

function buildGitMetadata(
  input: Record<string, unknown> | undefined,
  outputText: string,
  displayText: string | undefined,
): ToolActivityMetadata {
  return {
    family: TOOL_ACTIVITY_FAMILIES.GIT,
    displayText,
    pluginLabel: "GitHub",
    path: readString(input?.path),
    preview: outputText || undefined,
    count: countNonEmptyLines(outputText),
  };
}

function readToolMetadataDisplayText(
  metadata: ToolActivityMetadata,
): string | undefined {
  return metadata.displayText;
}

function readToolMetadataDescription(
  metadata: ToolActivityMetadata,
): string | undefined {
  return metadata.family === TOOL_ACTIVITY_FAMILIES.SHELL
    ? metadata.description
    : undefined;
}

function getReasoningLabel(step: string): string {
  switch (step) {
    case RUN_WORKFLOW_STEPS.PLANNING:
      return "Planning next step";
    case RUN_WORKFLOW_STEPS.EXECUTION:
      return "Preparing next action";
    case RUN_WORKFLOW_STEPS.SYNTHESIS:
      return "Summarizing the change";
    default:
      return "Workflow update";
  }
}

function getReasoningSummary(step: string): string {
  switch (step) {
    case RUN_WORKFLOW_STEPS.PLANNING:
      return "Preparing a safe execution plan for this request.";
    case RUN_WORKFLOW_STEPS.EXECUTION:
      return "Preparing the next concrete workspace action.";
    case RUN_WORKFLOW_STEPS.SYNTHESIS:
      return "Preparing the final user-facing answer from the observed results.";
    default:
      return "Updating workflow state.";
  }
}

function inferApprovalType(detail: string | undefined) {
  return detail?.toLowerCase().includes("workspace")
    ? "workspace_bootstrap"
    : "permission";
}

function inferApprovalSummary(detail: string | undefined): string {
  if (!detail?.trim()) {
    return "Approval required before continuing.";
  }
  const normalized = detail.trim();
  return normalized.endsWith(".") ? normalized : `${normalized}.`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitNonEmptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function countNonEmptyLines(value: string): number {
  return splitNonEmptyLines(value).length;
}

function truncateText(value: string, maxLength: number): string {
  const compact = value.trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function appendCappedText(
  current: string | undefined,
  delta: string | undefined,
  maxLength: number,
): { value: string; truncated: boolean } {
  const next = `${current ?? ""}${delta ?? ""}`;
  if (next.length <= maxLength) {
    return {
      value: next,
      truncated: false,
    };
  }
  return {
    value: next.slice(next.length - maxLength),
    truncated: true,
  };
}

function buildShellOutputTail(stdout: string, stderr: string): string {
  const sections: string[] = [];
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout) {
    sections.push(trimmedStdout);
  }
  if (trimmedStderr) {
    sections.push(`[stderr]\n${trimmedStderr}`);
  }

  const combined = sections.join("\n");
  if (combined.length <= SHELL_OUTPUT_TAIL_CAP) {
    return combined;
  }
  return combined.slice(combined.length - SHELL_OUTPUT_TAIL_CAP);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
