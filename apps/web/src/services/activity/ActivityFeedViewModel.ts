import {
  ACTIVITY_PART_KINDS,
  TOOL_ACTIVITY_FAMILIES,
  type ActivityFeedSnapshot,
  type ActivityPart,
  type FileStatus,
  type ToolActivityPart,
} from "@repo/shared-types";
import {
  getGitCommandLabel,
  getGitDetails,
  getGitSummary,
} from "./gitTranscript.js";

export interface ActivityFeedSummaryViewModel {
  elapsedLabel: string;
  toolCallsLabel: string;
  approvalsLabel: string | null;
  handoffLabel: string | null;
}

export interface ActivityTextRowViewModel {
  kind: "text";
  key: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityCommentaryRowViewModel {
  kind: "commentary";
  key: string;
  phase: "commentary" | "final_answer";
  status: "active" | "completed";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityReasoningRowViewModel {
  kind: "reasoning";
  key: string;
  label: string;
  summary: string;
  status: "active" | "completed";
}

export interface ActivityApprovalRowViewModel {
  kind: "approval";
  key: string;
  approvalType: "permission" | "workspace_bootstrap";
  status: "requested" | "granted" | "denied" | "expired";
  summary: string;
  details?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityHandoffRowViewModel {
  kind: "handoff";
  key: string;
  summary: string;
  prompt: string;
  status: "ready" | "accepted" | "dismissed";
}

export interface ActivityToolRowViewModel {
  kind: "tool";
  key: string;
  toolName: string;
  family: ToolActivityPart["metadata"]["family"];
  changedFile?: ActivityChangedFileStatus;
  pluginLabel?: string;
  title: string;
  summary: string;
  status: "requested" | "running" | "completed" | "failed";
  defaultCollapsed: boolean;
  details: string[];
}

export interface ActivityChangedFileStatus extends FileStatus {
  diffPreview?: string;
}

export interface ActivityGroupRowViewModel {
  kind: "group";
  key: string;
  title: string;
  summary: string;
  status: "requested" | "running" | "completed" | "failed";
  defaultCollapsed: boolean;
  rows: ActivityToolRowViewModel[];
}

export type ActivityFeedRowViewModel =
  | ActivityTextRowViewModel
  | ActivityCommentaryRowViewModel
  | ActivityReasoningRowViewModel
  | ActivityApprovalRowViewModel
  | ActivityHandoffRowViewModel
  | ActivityToolRowViewModel
  | ActivityGroupRowViewModel;

export interface ActivityTurnViewModel {
  key: string;
  userPrompt: string | null;
  elapsedLabel: string;
  summaryLabel: string;
  defaultCollapsed: boolean;
  isActiveTurn: boolean;
  hasVisibleRows: boolean;
  rows: ActivityFeedRowViewModel[];
}

export interface ActivityFeedViewModel {
  summary: ActivityFeedSummaryViewModel;
  turns: ActivityTurnViewModel[];
}

interface StaticActivityFeedSummaryViewModel {
  toolCallsLabel: string;
  approvalsLabel: string | null;
  handoffLabel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  isActive: boolean;
}

interface StaticActivityTurnViewModel {
  key: string;
  userPrompt: string | null;
  summaryLabel: string;
  defaultCollapsed: boolean;
  isActiveTurn: boolean;
  hasVisibleRows: boolean;
  rows: ActivityFeedRowViewModel[];
  startedAt: string | null;
  endedAt: string | null;
}

interface StaticActivityFeedViewModel {
  summary: StaticActivityFeedSummaryViewModel;
  turns: StaticActivityTurnViewModel[];
}

const LOW_SIGNAL_EXPLORATION_THRESHOLD = 2;
const GENERIC_EXECUTION_REASONING_SUMMARIES = new Set([
  "Preparing the next concrete workspace action.",
  "Running the selected coding tools.",
  "Deciding whether to read, search, edit, run a command, or respond.",
]);
const GENERIC_PLANNING_REASONING_SUMMARIES = new Set([
  "Preparing a safe execution plan for this request.",
]);
const GENERIC_SYNTHESIS_REASONING_SUMMARIES = new Set([
  "Preparing the operational plan.",
  "Preparing the final user-facing answer from the observed results.",
  "Summarizing execution results for the final response.",
]);
const GENERIC_REASONING_LABELS_BY_PHASE = {
  planning: "Planning next step",
  execution: "Preparing next action",
  synthesis: "Summarizing the change",
} as const;

export function buildActivityFeedViewModel(
  feed: ActivityFeedSnapshot | null,
  nowMs: number = Date.now(),
): ActivityFeedViewModel {
  return withActivityFeedElapsedLabels(
    buildStaticActivityFeedViewModel(feed),
    nowMs,
  );
}

export function buildStaticActivityFeedViewModel(
  feed: ActivityFeedSnapshot | null,
): StaticActivityFeedViewModel {
  if (!feed) {
    return {
      summary: {
        toolCallsLabel: "0 tool calls",
        approvalsLabel: null,
        handoffLabel: null,
        startedAt: null,
        endedAt: null,
        isActive: false,
      },
      turns: [],
    };
  }

  const turnGroups = groupItemsIntoTurns(feed.items);
  const lastTurnIndex = turnGroups.length - 1;
  return {
    summary: buildStaticFeedSummary(feed),
    turns: turnGroups.flatMap((turn, index) => {
      const turnKey = resolveActivityTurnKey(feed.runId, turn.turnId, index);
      if (!turnKey) {
        return [];
      }

      const isActiveTurn = feed.status === "RUNNING" && index === lastTurnIndex;
      const rows = buildTurnRows(turn.items, isActiveTurn);
      const startedAt = turn.items[0]?.createdAt ?? null;
      const endedAt = turn.items[turn.items.length - 1]?.updatedAt ?? null;
      return [
        {
          key: turnKey,
          userPrompt: getTurnUserPrompt(turn.items),
          summaryLabel: buildTurnSummary(rows),
          defaultCollapsed: !isActiveTurn && !hasProviderInterruption(rows),
          isActiveTurn,
          hasVisibleRows: rows.length > 0,
          rows,
          startedAt,
          endedAt,
        },
      ];
    }),
  };
}

export function withActivityFeedElapsedLabels(
  viewModel: StaticActivityFeedViewModel,
  nowMs: number = Date.now(),
): ActivityFeedViewModel {
  const summaryElapsedLabel = viewModel.summary.startedAt
    ? formatDuration(
        viewModel.summary.startedAt,
        viewModel.summary.endedAt,
        viewModel.summary.isActive,
        nowMs,
      )
    : "Waiting for activity";

  return {
    summary: {
      elapsedLabel: summaryElapsedLabel,
      toolCallsLabel: viewModel.summary.toolCallsLabel,
      approvalsLabel: viewModel.summary.approvalsLabel,
      handoffLabel: viewModel.summary.handoffLabel,
    },
    turns: viewModel.turns.map((turn) => ({
      key: turn.key,
      userPrompt: turn.userPrompt,
      elapsedLabel: formatDuration(
        turn.startedAt,
        turn.endedAt,
        turn.isActiveTurn,
        nowMs,
      ),
      summaryLabel: turn.summaryLabel,
      defaultCollapsed: turn.defaultCollapsed,
      isActiveTurn: turn.isActiveTurn,
      hasVisibleRows: turn.hasVisibleRows,
      rows: turn.rows,
    })),
  };
}

function resolveActivityTurnKey(
  runId: string,
  turnId: string | undefined,
  index: number,
): string | null {
  if (!turnId) {
    console.warn(
      "[activity/feed] Skipping activity turn without canonical turnId.",
      { index, runId },
    );
    return null;
  }

  return turnId;
}

function groupItemsIntoTurns(
  items: ActivityPart[],
): Array<{ turnId?: string; items: ActivityPart[] }> {
  const grouped: Array<{ turnId?: string; items: ActivityPart[] }> = [];
  for (const item of items) {
    const last = grouped[grouped.length - 1];
    if (!last || last.turnId !== item.turnId) {
      grouped.push({ turnId: item.turnId, items: [item] });
      continue;
    }
    last.items.push(item);
  }
  return grouped;
}

function buildTurnRows(
  items: ActivityPart[],
  isActiveTurn: boolean,
): ActivityFeedRowViewModel[] {
  const rows: ActivityFeedRowViewModel[] = [];
  let pendingExplore: ActivityToolRowViewModel[] = [];
  let trailingThinkingRow: ActivityReasoningRowViewModel | null = null;

  for (const item of items) {
    if (item.kind === ACTIVITY_PART_KINDS.TEXT) {
      if (shouldDisplayTextRow(item)) {
        flushExploreGroup(rows, pendingExplore);
        pendingExplore = [];
        trailingThinkingRow = null;
        pushActivityRow(rows, createLegacyCommentaryRow(item));
      }
      continue;
    }

    if (item.kind === ACTIVITY_PART_KINDS.COMMENTARY) {
      if (shouldDisplayCommentaryRow(item)) {
        flushExploreGroup(rows, pendingExplore);
        pendingExplore = [];
        trailingThinkingRow = null;
        pushActivityRow(rows, createNonToolRow(item));
      }
      continue;
    }

    if (
      item.kind === ACTIVITY_PART_KINDS.REASONING &&
      isSuppressedReasoning(item)
    ) {
      continue;
    }

    if (item.kind === ACTIVITY_PART_KINDS.REASONING) {
      const reasoningRow = createNonToolRow(item);
      if (isTrailingThinkingIndicatorRow(reasoningRow)) {
        // "Thinking" is only a live trailing state indicator. Once commentary
        // or concrete work happens after it, we drop it from transcript history.
        trailingThinkingRow = reasoningRow;
        continue;
      }

      flushExploreGroup(rows, pendingExplore);
      pendingExplore = [];
      trailingThinkingRow = null;
      pushActivityRow(rows, reasoningRow);
      continue;
    }

    if (item.kind === ACTIVITY_PART_KINDS.TOOL) {
      const row = createToolRow(item);
      if (isExplorationTool(row)) {
        pendingExplore.push(row);
        continue;
      }
      flushExploreGroup(rows, pendingExplore);
      pendingExplore = [];
      trailingThinkingRow = null;
      rows.push(row);
      continue;
    }

    if (shouldSuppressApprovalRow(item)) {
      continue;
    }

    flushExploreGroup(rows, pendingExplore);
    pendingExplore = [];
    trailingThinkingRow = null;
    pushActivityRow(rows, createNonToolRow(item));
  }

  flushExploreGroup(rows, pendingExplore);
  if (shouldRenderTrailingThinkingRow(trailingThinkingRow, isActiveTurn)) {
    pushActivityRow(rows, trailingThinkingRow);
  }
  return finalizeTurnRows(rows, isActiveTurn);
}

function shouldRenderTrailingThinkingRow(
  row: ActivityReasoningRowViewModel | null,
  isActiveTurn: boolean,
): row is ActivityReasoningRowViewModel {
  return Boolean(
    row &&
    isTrailingThinkingIndicatorRow(row) &&
    isActiveTurn &&
    row.status === "active",
  );
}

function finalizeTurnRows(
  rows: ActivityFeedRowViewModel[],
  isActiveTurn: boolean,
): ActivityFeedRowViewModel[] {
  return rows.filter(
    (row) =>
      !isThinkingReasoningRow(row) || (isActiveTurn && row.status === "active"),
  );
}

function pushActivityRow(
  rows: ActivityFeedRowViewModel[],
  nextRow: ActivityFeedRowViewModel,
): void {
  if (isThinkingReasoningRow(nextRow)) {
    const lastRow = rows[rows.length - 1];
    if (isThinkingReasoningRow(lastRow)) {
      rows[rows.length - 1] = nextRow;
      return;
    }
  }

  rows.push(nextRow);
}

function getTurnUserPrompt(items: ActivityPart[]): string | null {
  for (const item of items) {
    if (item.kind === ACTIVITY_PART_KINDS.TEXT && item.role === "user") {
      const content = item.content.trim();
      return content || null;
    }
  }

  return null;
}

function buildTurnSummary(rows: ActivityFeedRowViewModel[]): string {
  if (hasProviderInterruption(rows)) {
    return "Paused after provider interruption";
  }

  const toolCount = rows.reduce((count, row) => {
    if (row.kind === "tool") {
      return count + 1;
    }
    if (row.kind === "group") {
      return count + row.rows.length;
    }
    return count;
  }, 0);
  const reasoningCount = rows.filter((row) => row.kind === "reasoning").length;
  const approvalCount = rows.filter((row) => row.kind === "approval").length;
  const handoffCount = rows.filter((row) => row.kind === "handoff").length;
  const failureCount = rows.reduce((count, row) => {
    if (row.kind === "tool") {
      return count + (row.status === "failed" ? 1 : 0);
    }
    if (row.kind === "group") {
      return (
        count +
        row.rows.filter((groupRow) => groupRow.status === "failed").length
      );
    }
    return count;
  }, 0);

  const parts: string[] = [];
  if (toolCount > 0) {
    parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  }
  if (reasoningCount > 0) {
    parts.push(
      `${reasoningCount} progress update${reasoningCount === 1 ? "" : "s"}`,
    );
  }
  if (approvalCount > 0) {
    parts.push(`${approvalCount} approval${approvalCount === 1 ? "" : "s"}`);
  }
  if (handoffCount > 0) {
    parts.push(`${handoffCount} handoff${handoffCount === 1 ? "" : "s"}`);
  }
  if (failureCount > 0) {
    parts.push(`${failureCount} failure${failureCount === 1 ? "" : "s"}`);
  }

  return parts[0] ? parts.slice(0, 3).join(" · ") : "Workflow captured";
}

function hasProviderInterruption(rows: ActivityFeedRowViewModel[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "commentary" &&
      row.metadata?.code === "PROVIDER_UNAVAILABLE",
  );
}

function isThinkingReasoningRow(
  row: ActivityFeedRowViewModel | undefined,
): row is ActivityReasoningRowViewModel {
  return row?.kind === "reasoning" && row.label === "Thinking";
}

function isTrailingThinkingIndicatorRow(
  row: ActivityFeedRowViewModel | undefined,
): row is ActivityReasoningRowViewModel {
  return isThinkingReasoningRow(row) && row.summary === "";
}

function createNonToolRow(item: Exclude<ActivityPart, ToolActivityPart>) {
  switch (item.kind) {
    case ACTIVITY_PART_KINDS.TEXT:
      return {
        kind: "text",
        key: item.id,
        role: item.role,
        content: item.content,
        metadata: item.metadata,
      } satisfies ActivityTextRowViewModel;
    case ACTIVITY_PART_KINDS.COMMENTARY:
      return {
        kind: "commentary",
        key: item.id,
        phase: item.phase,
        status: item.status,
        text: item.text,
        metadata: item.metadata,
      } satisfies ActivityCommentaryRowViewModel;
    case ACTIVITY_PART_KINDS.REASONING:
      return {
        kind: "reasoning",
        key: item.id,
        label: getReasoningLabel(item),
        summary: normalizeReasoningSummary(item.summary, item.phase),
        status: item.status,
      } satisfies ActivityReasoningRowViewModel;
    case ACTIVITY_PART_KINDS.APPROVAL:
      return {
        kind: "approval",
        key: item.id,
        approvalType: item.approvalType,
        status: item.status,
        summary: item.summary,
        details: item.details,
        metadata: readActivityPartMetadata(item),
      } satisfies ActivityApprovalRowViewModel;
    case ACTIVITY_PART_KINDS.HANDOFF:
      return {
        kind: "handoff",
        key: item.id,
        summary: item.summary,
        prompt: item.prompt,
        status: item.status,
      } satisfies ActivityHandoffRowViewModel;
  }
}

function readActivityPartMetadata(
  item: ActivityPart,
): Record<string, unknown> | undefined {
  const value = (item as { metadata?: unknown }).metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSuppressedReasoning(
  item: Extract<ActivityPart, { kind: typeof ACTIVITY_PART_KINDS.REASONING }>,
): boolean {
  const normalizedSummary = normalizeReasoningSummary(item.summary, item.phase);
  const authoredLabel = item.label.trim();
  if (authoredLabel === "RuntimeKernel lifecycle") {
    return true;
  }
  const genericPhaseLabel = item.phase
    ? GENERIC_REASONING_LABELS_BY_PHASE[item.phase]
    : undefined;
  return (
    (item.status !== "active" &&
      normalizedSummary === "" &&
      authoredLabel === genericPhaseLabel) ||
    (item.phase === "synthesis" &&
      normalizedSummary === "" &&
      authoredLabel === "") ||
    (item.phase === "planning" &&
      normalizedSummary === "" &&
      (authoredLabel === "" || authoredLabel === "Planning next step"))
  );
}

function normalizeReasoningSummary(
  summary: string,
  phase?: Extract<
    ActivityPart,
    { kind: typeof ACTIVITY_PART_KINDS.REASONING }
  >["phase"],
): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return "";
  }

  if (isGenericExecutionReasoningSummary(trimmed, phase)) {
    return "";
  }

  if (isGenericPlanningReasoningSummary(trimmed, phase)) {
    return "";
  }

  if (isGenericSynthesisReasoningSummary(trimmed, phase)) {
    return "";
  }

  return trimmed;
}

function getReasoningLabel(
  item: Extract<ActivityPart, { kind: typeof ACTIVITY_PART_KINDS.REASONING }>,
): string {
  const authoredLabel = item.label.trim();
  if (authoredLabel) {
    return authoredLabel;
  }

  const normalizedSummary = normalizeReasoningSummary(item.summary, item.phase);
  if (item.phase === "execution" && normalizedSummary === "") {
    return "Thinking";
  }

  switch (item.phase) {
    case "planning":
      return "Planning next step";
    case "execution":
      return "Preparing next action";
    case "synthesis":
      return "Summarizing the change";
    default:
      return "Workflow update";
  }
}

function shouldDisplayTextRow(
  item: Extract<ActivityPart, { kind: typeof ACTIVITY_PART_KINDS.TEXT }>,
): boolean {
  if (item.role === "user") {
    return false;
  }

  // The activity transcript only promotes terminal recovery messages.
  // Normal assistant replies stay in the main chat transcript instead of duplicating here.
  const code =
    typeof item.metadata?.code === "string" ? item.metadata.code : undefined;
  return code === "TASK_EXECUTION_TIMEOUT" || code === "TASK_MODEL_NO_ACTION";
}

function createLegacyCommentaryRow(
  item: Extract<ActivityPart, { kind: typeof ACTIVITY_PART_KINDS.TEXT }>,
): ActivityCommentaryRowViewModel {
  return {
    kind: "commentary",
    key: item.id,
    phase: "commentary",
    status: "completed",
    text: item.content,
    metadata: item.metadata,
  };
}

function shouldDisplayCommentaryRow(
  item: Extract<ActivityPart, { kind: typeof ACTIVITY_PART_KINDS.COMMENTARY }>,
): boolean {
  if (item.phase === "final_answer") {
    return false;
  }

  return true;
}

function shouldSuppressApprovalRow(item: ActivityPart): boolean {
  return (
    item.kind === ACTIVITY_PART_KINDS.APPROVAL && item.status === "granted"
  );
}

function createToolRow(item: ToolActivityPart): ActivityToolRowViewModel {
  return {
    kind: "tool",
    key: item.id,
    toolName: item.toolName,
    family: item.metadata.family,
    changedFile: buildChangedFileStatus(item),
    pluginLabel: readToolPluginLabel(item),
    title: getToolTitle(item),
    summary: getToolSummary(item),
    status: item.status,
    defaultCollapsed:
      item.metadata.family !== TOOL_ACTIVITY_FAMILIES.SHELL &&
      item.metadata.family !== TOOL_ACTIVITY_FAMILIES.GIT &&
      item.metadata.family !== TOOL_ACTIVITY_FAMILIES.EDIT &&
      item.status === "completed",
    details: getToolDetails(item),
  };
}

function buildChangedFileStatus(
  item: ToolActivityPart,
): ActivityChangedFileStatus | undefined {
  if (item.metadata.family !== TOOL_ACTIVITY_FAMILIES.EDIT) {
    return undefined;
  }

  return {
    path: item.metadata.filePath,
    status: "modified",
    additions: item.metadata.additions,
    deletions: item.metadata.deletions,
    isStaged: false,
    diffPreview: item.metadata.diffPreview,
  };
}

function isExplorationTool(row: ActivityToolRowViewModel): boolean {
  return (
    (row.family === TOOL_ACTIVITY_FAMILIES.READ ||
      row.family === TOOL_ACTIVITY_FAMILIES.SEARCH) &&
    row.status !== "failed"
  );
}

function flushExploreGroup(
  rows: ActivityFeedRowViewModel[],
  exploreRows: ActivityToolRowViewModel[],
): void {
  if (exploreRows.length === 0) {
    return;
  }
  if (exploreRows.length < LOW_SIGNAL_EXPLORATION_THRESHOLD) {
    rows.push(...exploreRows);
    return;
  }
  const hasFailedRows = exploreRows.some((row) => row.status === "failed");
  const hasRunningRows = exploreRows.some(
    (row) => row.status === "requested" || row.status === "running",
  );
  const groupCopy = buildExploreGroupCopy(exploreRows, hasRunningRows);
  rows.push({
    kind: "group",
    key: `explore-${exploreRows[0]?.key ?? "group"}`,
    title: groupCopy.title,
    summary: groupCopy.summary,
    status: hasFailedRows ? "failed" : hasRunningRows ? "running" : "completed",
    defaultCollapsed: !hasRunningRows,
    rows: [...exploreRows],
  });
}

function buildExploreGroupCopy(
  exploreRows: ActivityToolRowViewModel[],
  hasRunningRows: boolean,
): { title: string; summary: string } {
  const title = resolveExploreGroupTitle({
    hasRunningRows,
  });
  return {
    title,
    summary: summarizeExploreGroup(exploreRows),
  };
}

function resolveExploreGroupTitle(input: { hasRunningRows: boolean }): string {
  return input.hasRunningRows ? "Exploring" : "Explored";
}

function summarizeExploreGroup(
  exploreRows: ActivityToolRowViewModel[],
): string {
  const listCount = exploreRows.filter(
    (row) => row.toolName === "list_files",
  ).length;
  const fileCount = exploreRows.filter(
    (row) =>
      row.family === TOOL_ACTIVITY_FAMILIES.READ &&
      row.toolName !== "list_files",
  ).length;
  const searchCount = exploreRows.filter(
    (row) => row.family === TOOL_ACTIVITY_FAMILIES.SEARCH,
  ).length;
  const parts = [
    formatExploreCount(listCount, "list"),
    formatExploreCount(fileCount, "file"),
    formatExploreCount(searchCount, "search"),
  ].filter(Boolean);

  return (
    parts.join(", ") ||
    `${exploreRows.length} step${exploreRows.length === 1 ? "" : "s"}`
  );
}

function formatExploreCount(
  count: number,
  label: "list" | "file" | "search",
): string {
  if (count === 0) {
    return "";
  }

  if (label === "search") {
    return `${count} search${count === 1 ? "" : "es"}`;
  }

  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function isGenericExecutionReasoningSummary(
  summary: string,
  phase?: Extract<
    ActivityPart,
    { kind: typeof ACTIVITY_PART_KINDS.REASONING }
  >["phase"],
): boolean {
  return (
    phase === "execution" && GENERIC_EXECUTION_REASONING_SUMMARIES.has(summary)
  );
}

function isGenericPlanningReasoningSummary(
  summary: string,
  phase?: Extract<
    ActivityPart,
    { kind: typeof ACTIVITY_PART_KINDS.REASONING }
  >["phase"],
): boolean {
  return (
    phase === "planning" && GENERIC_PLANNING_REASONING_SUMMARIES.has(summary)
  );
}

function isGenericSynthesisReasoningSummary(
  summary: string,
  phase?: Extract<
    ActivityPart,
    { kind: typeof ACTIVITY_PART_KINDS.REASONING }
  >["phase"],
): boolean {
  return (
    phase === "synthesis" && GENERIC_SYNTHESIS_REASONING_SUMMARIES.has(summary)
  );
}

function getToolTitle(item: ToolActivityPart): string {
  if (item.metadata.displayText) {
    return item.metadata.displayText;
  }

  switch (item.metadata.family) {
    case TOOL_ACTIVITY_FAMILIES.SHELL:
      return item.metadata.command;
    case TOOL_ACTIVITY_FAMILIES.EDIT:
      return `Edit ${item.metadata.filePath}`;
    case TOOL_ACTIVITY_FAMILIES.READ:
      return getReadToolTitle(item);
    case TOOL_ACTIVITY_FAMILIES.SEARCH:
      return getSearchToolTitle(item);
    case TOOL_ACTIVITY_FAMILIES.GIT:
      return getGitCommandLabel(item);
    default:
      return humanizeToolName(item.toolName);
  }
}

function readToolPluginLabel(item: ToolActivityPart): string | undefined {
  if (item.metadata.family !== TOOL_ACTIVITY_FAMILIES.GIT) {
    return undefined;
  }

  return item.metadata.pluginLabel;
}

function getReadToolTitle(item: ToolActivityPart): string {
  if (item.metadata.family !== TOOL_ACTIVITY_FAMILIES.READ) {
    return humanizeToolName(item.toolName);
  }

  if (item.toolName === "list_files") {
    return item.metadata.path && item.metadata.path !== "."
      ? `List ${item.metadata.path}`
      : "List project files";
  }

  return item.metadata.path ? `Read ${item.metadata.path}` : "Read file";
}

function getSearchToolTitle(item: ToolActivityPart): string {
  if (item.metadata.family !== TOOL_ACTIVITY_FAMILIES.SEARCH) {
    return humanizeToolName(item.toolName);
  }

  if (item.toolName === "glob") {
    return item.metadata.pattern
      ? `Find ${item.metadata.pattern}`
      : "Find files";
  }

  if (item.metadata.pattern) {
    return `Search ${item.metadata.pattern}`;
  }

  return item.metadata.path && item.metadata.path !== "."
    ? `Search ${item.metadata.path}`
    : "Search project";
}

function getToolSummary(item: ToolActivityPart): string {
  switch (item.metadata.family) {
    case TOOL_ACTIVITY_FAMILIES.SHELL:
      return item.status === "failed"
        ? "Command failed"
        : item.status === "running"
          ? "Running"
          : item.status === "requested"
            ? "Queued"
            : "";
    case TOOL_ACTIVITY_FAMILIES.EDIT:
      return `+${item.metadata.additions} / -${item.metadata.deletions}`;
    case TOOL_ACTIVITY_FAMILIES.READ:
    case TOOL_ACTIVITY_FAMILIES.SEARCH:
      return "";
    case TOOL_ACTIVITY_FAMILIES.GIT:
      return getGitSummary(item);
    default:
      return humanizeToolStatus(item.status);
  }
}

function getToolDetails(item: ToolActivityPart): string[] {
  switch (item.metadata.family) {
    case TOOL_ACTIVITY_FAMILIES.SHELL:
      return [
        item.metadata.command ? `$ ${item.metadata.command}` : "",
        item.metadata.cwd ? `cwd: ${item.metadata.cwd}` : "",
        item.metadata.outputTail
          ? `${item.metadata.command ? "\n" : ""}${item.metadata.outputTail}`
          : "",
        item.metadata.truncated
          ? "Output truncated to the latest shell tail."
          : "",
      ].filter(Boolean);
    case TOOL_ACTIVITY_FAMILIES.EDIT:
      return [item.metadata.diffPreview ?? ""].filter(Boolean);
    case TOOL_ACTIVITY_FAMILIES.READ:
    case TOOL_ACTIVITY_FAMILIES.SEARCH:
      return [item.metadata.preview ?? ""].filter(Boolean);
    case TOOL_ACTIVITY_FAMILIES.GIT:
      return getGitDetails(item);
    default:
      return [];
  }
}

function buildStaticFeedSummary(
  feed: ActivityFeedSnapshot,
): StaticActivityFeedSummaryViewModel {
  const toolCount = feed.items.filter(
    (item) => item.kind === ACTIVITY_PART_KINDS.TOOL,
  ).length;
  const approvalCount = feed.items.filter(
    (item) =>
      item.kind === ACTIVITY_PART_KINDS.APPROVAL && item.status !== "granted",
  ).length;
  const handoffCount = feed.items.filter(
    (item) => item.kind === ACTIVITY_PART_KINDS.HANDOFF,
  ).length;
  const startedAt = feed.items[0]?.createdAt ?? null;
  const endedAt = feed.items[feed.items.length - 1]?.updatedAt ?? null;

  return {
    toolCallsLabel: `${toolCount} tool call${toolCount === 1 ? "" : "s"}`,
    approvalsLabel:
      approvalCount > 0
        ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
        : null,
    handoffLabel:
      handoffCount > 0
        ? `${handoffCount} handoff${handoffCount === 1 ? "" : "s"}`
        : null,
    startedAt,
    endedAt,
    isActive: feed.status === "RUNNING",
  };
}

function formatDuration(
  startedAt: string | null,
  endedAt: string | null,
  isActive: boolean = false,
  nowMs: number = Date.now(),
): string {
  if (!startedAt) {
    return isActive ? "Working now" : "Started just now";
  }

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return isActive ? "Working now" : "Started just now";
  }

  const endedAtMs = isActive ? nowMs : Date.parse(endedAt ?? "");
  if (Number.isNaN(endedAtMs)) {
    return isActive ? "Working now" : "Started just now";
  }

  const elapsedMs = Math.max(0, endedAtMs - startedAtMs);
  if (elapsedMs < 1_000) {
    return isActive ? "Working for 1s" : "Started just now";
  }
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${isActive ? "Working" : "Worked"} for ${seconds}s`;
  }
  return `${isActive ? "Working" : "Worked"} for ${minutes}m ${seconds}s`;
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanizeToolStatus(
  status: ActivityToolRowViewModel["status"],
): string {
  switch (status) {
    case "requested":
      return "Queued";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    default:
      return "Completed";
  }
}
