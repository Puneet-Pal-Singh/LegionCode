import type {
  WorkflowItem,
  WorkflowItemKind,
} from "./turn-workflow-projection.js";
import type { TurnDiffPayload } from "@repo/platform-protocol";

export interface ToolActivitySegment {
  readonly key: string;
  readonly reasoning: WorkflowItem | null;
  readonly children: readonly WorkflowItem[];
  readonly familyLabels: readonly string[];
  readonly isActive: boolean;
}

export interface ActiveWorkflowTraceProjection {
  readonly title: string;
  readonly children: readonly WorkflowItem[];
  readonly consumedSegmentKeys: readonly string[];
}

const HARD_BOUNDARY_KINDS: ReadonlySet<WorkflowItemKind> = new Set([
  "commentary",
  "context_compaction",
  "warning",
]);

export function groupToolActivity(
  items: readonly WorkflowItem[],
  turnDiff: TurnDiffPayload | null = null,
): readonly ToolActivitySegment[] {
  const segments: ToolActivitySegment[] = [];
  let current: ToolActivitySegment | null = null;

  for (const sourceItem of items) {
    const item = enrichEditFromCanonicalTurnDiff(sourceItem, turnDiff);
    current = groupWorkflowItem(segments, current, item);
  }

  return segments;
}

function groupWorkflowItem(
  segments: ToolActivitySegment[],
  current: ToolActivitySegment | null,
  item: WorkflowItem,
): ToolActivitySegment | null {
  if (item.kind === "approval_request") return null;
  if (item.toolName === "multi_edit") return current;
  if (item.kind === "reasoning" || item.kind === "plan") {
    return appendReasoningSegment(segments, item) ?? current;
  }
  if (isToolItem(item)) {
    return appendToolItem(segments, current, item);
  }
  if (HARD_BOUNDARY_KINDS.has(item.kind)) {
    segments.push(createStandaloneSegment(item));
  }
  return null;
}

function appendReasoningSegment(
  segments: ToolActivitySegment[],
  item: WorkflowItem,
): ToolActivitySegment | null {
  const hasContent = Boolean(item.safeSummary?.trim() || item.text.trim());
  if (
    !hasContent ||
    (item.status !== "active" && item.status !== "completed")
  ) {
    return null;
  }
  const segment = createSegment(item);
  segments.push(segment);
  return segment;
}

function appendToolItem(
  segments: ToolActivitySegment[],
  current: ToolActivitySegment | null,
  item: WorkflowItem,
): ToolActivitySegment {
  const segment = shouldStartToolSegment(current)
    ? createSegment(item)
    : current!;
  if (segment !== current) segments.push(segment);
  const children = coalesceRepeatedFileActivity(segment.children, item);
  const next = {
    ...segment,
    children,
    familyLabels: deriveFamilyLabels(children.slice(0, -1), item),
    isActive: isSegmentActive(segment.reasoning, children),
  };
  segments[segments.length - 1] = next;
  return next;
}

function shouldStartToolSegment(current: ToolActivitySegment | null): boolean {
  return (
    !current ||
    (current.children.length > 0 && !current.children.some(isToolItem))
  );
}

function enrichEditFromCanonicalTurnDiff(
  item: WorkflowItem,
  turnDiff: TurnDiffPayload | null,
): WorkflowItem {
  if (
    item.toolFamily !== "edit" ||
    !item.filePath ||
    !turnDiff ||
    item.diffPreview
  ) {
    return item;
  }
  const changedFile = turnDiff.files.find(
    (candidate) =>
      candidate.path === item.filePath ||
      candidate.previousPath === item.filePath,
  );
  if (!changedFile) return item;

  return {
    ...item,
    diffPreview: extractFilePatch(turnDiff, changedFile.path),
    additions: item.additions ?? changedFile.additions,
    deletions: item.deletions ?? changedFile.deletions,
  };
}

function extractFilePatch(
  turnDiff: TurnDiffPayload,
  filePath: string,
): string | null {
  const sections = turnDiff.patch.split(/(?=^diff --git )/mu).filter(Boolean);
  const section =
    sections.find((candidate) => {
      const header = candidate.split("\n", 1)[0] ?? "";
      return (
        header === `diff --git a/${filePath} b/${filePath}` ||
        header.endsWith(` b/${filePath}`)
      );
    }) ?? (turnDiff.files.length === 1 ? turnDiff.patch : null);
  return section?.trim().slice(0, 16_000) || null;
}

function coalesceRepeatedFileActivity(
  children: readonly WorkflowItem[],
  item: WorkflowItem,
): readonly WorkflowItem[] {
  if (
    (item.toolFamily !== "read" && item.toolFamily !== "edit") ||
    !activityTarget(item)
  ) {
    return [...children, item];
  }
  const matchingIndex = children.findIndex(
    (candidate) =>
      candidate.toolFamily === item.toolFamily &&
      activityTarget(candidate) === activityTarget(item),
  );
  if (matchingIndex < 0) {
    return [...children, item];
  }
  return children.map((candidate, index) =>
    index === matchingIndex
      ? {
          ...item,
          outputContent: selectCoalescedOutputContent(candidate, item),
          itemId: candidate.itemId,
          sequence: candidate.sequence,
          startedAt: candidate.startedAt,
        }
      : candidate,
  );
}

function selectCoalescedOutputContent(
  previous: WorkflowItem,
  current: WorkflowItem,
): string | null {
  if (
    current.toolFamily === "read" &&
    current.outputContent?.includes("returnedLines=0")
  ) {
    return previous.outputContent ?? current.outputContent;
  }
  return current.outputContent ?? previous.outputContent;
}

function activityTarget(item: WorkflowItem): string | null {
  return item.filePath?.trim() || item.inputSummary?.trim() || null;
}

function isToolItem(item: WorkflowItem): boolean {
  return (
    item.kind === "tool_call" ||
    item.kind === "command_execution" ||
    item.kind === "file_change"
  );
}

function createSegment(item: WorkflowItem): ToolActivitySegment {
  const key = `segment:${item.itemId}`;
  return {
    key,
    reasoning: item.kind === "reasoning" || item.kind === "plan" ? item : null,
    children: [],
    familyLabels: [],
    isActive: item.status === "active",
  };
}

function createStandaloneSegment(item: WorkflowItem): ToolActivitySegment {
  return {
    key: `segment:${item.itemId}`,
    reasoning: null,
    children: [item],
    familyLabels: [getItemFamilyLabel(item)],
    isActive: item.status === "active",
  };
}

function deriveFamilyLabels(
  previousChildren: readonly WorkflowItem[],
  newItem: WorkflowItem,
): readonly string[] {
  const labels = [...new Set(previousChildren.map(getItemFamilyLabel))];
  const newLabel = getItemFamilyLabel(newItem);
  if (!labels.includes(newLabel)) {
    labels.push(newLabel);
  }
  return labels;
}

function getItemFamilyLabel(item: WorkflowItem): string {
  switch (item.kind) {
    case "context_compaction":
      return "context compaction";
    case "warning":
      return "warning";
    default:
      break;
  }
  return item.toolFamily ?? "tool calls";
}

export function buildSegmentTitle(segment: ToolActivitySegment): string {
  if (segment.isActive) {
    const activeTool = segment.children.find(
      (item) => item.status === "active" && isToolItem(item),
    );
    const activeToolTitle = visibleActivityTitle(activeTool);
    if (activeToolTitle) {
      return activeToolTitle;
    }

    const reasoningTitle = visibleReasoningTitle(segment.reasoning);
    if (reasoningTitle) {
      return reasoningTitle;
    }
  }

  const labels = segment.familyLabels;
  if (labels.length === 0) {
    return segment.reasoning?.safeSummary?.trim() || "Thinking";
  }
  return labels.map(toActivityPhrase).join(", ");
}

export function buildActiveWorkflowTrace(
  segments: readonly ToolActivitySegment[],
): ActiveWorkflowTraceProjection {
  const traceSegments = collectCurrentTraceSegments(segments);
  const children = traceSegments.flatMap((segment) =>
    segment.children.filter(isToolItem),
  );
  const activeSegment = [...traceSegments]
    .reverse()
    .find((segment) => segment.children.some(isActiveToolItem));
  const reasoningTitle = [...traceSegments]
    .reverse()
    .map((segment) => visibleReasoningTitle(segment.reasoning, false))
    .find((title): title is string => Boolean(title));

  if (activeSegment) {
    return {
      title: buildSegmentTitle(activeSegment),
      children,
      consumedSegmentKeys: traceSegments.map((segment) => segment.key),
    };
  }

  if (reasoningTitle) {
    return {
      title: reasoningTitle,
      children,
      consumedSegmentKeys: traceSegments.map((segment) => segment.key),
    };
  }

  const latestTool = children.at(-1);
  if (latestTool) {
    return {
      title:
        visibleActivityTitle(latestTool) ?? "Thinking through the next step",
      children,
      consumedSegmentKeys: traceSegments.map((segment) => segment.key),
    };
  }

  return {
    title: "Thinking through the next step",
    children: [],
    consumedSegmentKeys: [],
  };
}

function collectCurrentTraceSegments(
  segments: readonly ToolActivitySegment[],
): readonly ToolActivitySegment[] {
  const current: ToolActivitySegment[] = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (segment.children.some((item) => HARD_BOUNDARY_KINDS.has(item.kind))) {
      break;
    }
    if (
      segment.reasoning ||
      segment.children.some((item) => isToolItem(item))
    ) {
      current.push(segment);
    }
  }
  return current.reverse();
}

/**
 * Returns the short, user-visible status for a workflow segment.
 *
 * Only display-safe lifecycle fields are considered here. In particular, the
 * projection never turns private reasoning into a status title. Active tool
 * display data wins while a command is running; the already-visible reasoning
 * or plan summary remains as the stable fallback between tool calls.
 */
function visibleActivityTitle(item: WorkflowItem | undefined): string | null {
  if (!item) return null;
  const visibleTitle = compactActivityTitle(
    item.safeSummary ?? item.detail ?? item.inputSummary,
  );
  if (visibleTitle && wordCount(visibleTitle) >= 4) return visibleTitle;
  return activeToolFallback(item);
}

function visibleReasoningTitle(
  item: WorkflowItem | null,
  useFallback = true,
): string | null {
  if (!item) return null;
  const visibleTitle = compactActivityTitle(
    item.safeSummary ?? item.text ?? item.detail,
  );
  if (visibleTitle && wordCount(visibleTitle) >= 4) return visibleTitle;
  if (visibleTitle) return visibleTitle;
  return useFallback ? "Thinking through the next step" : null;
}

function isActiveToolItem(item: WorkflowItem): boolean {
  return item.status === "active" && isToolItem(item);
}

function isSegmentActive(
  reasoning: WorkflowItem | null,
  children: readonly WorkflowItem[],
): boolean {
  return reasoning?.status === "active" || children.some(isActiveToolItem);
}

function compactActivityTitle(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length <= 6) return normalized;
  return `${words.slice(0, 6).join(" ")}…`;
}

function wordCount(value: string): number {
  return value.replace(/…$/u, "").trim().split(/\s+/u).length;
}

function activeToolFallback(item: WorkflowItem): string {
  switch (item.toolFamily) {
    case "read":
      return "Reading the selected source file";
    case "search":
      return "Searching the relevant project files";
    case "edit":
      return "Editing the selected project files";
    case "shell":
      return "Running the current command now";
    case "git":
      return "Checking the current Git state";
    case "web":
    case "browser":
      return "Searching the web for context";
    default:
      return "Running the current tool now";
  }
}

function toActivityPhrase(label: string): string {
  switch (label.toLowerCase()) {
    case "read":
      return "read files";
    case "search":
      return "searched files";
    case "edit":
      return "edited files";
    case "shell":
      return "ran commands";
    case "git":
      return "used Git";
    case "web":
    case "browser":
      return "searched the web";
    case "context compaction":
      return "compacted context";
    case "warning":
      return "reported a warning";
    case "tool calls":
      return "used a tool";
    default:
      return `used ${label}`;
  }
}
