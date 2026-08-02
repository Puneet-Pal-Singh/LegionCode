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

const HARD_BOUNDARY_KINDS: ReadonlySet<WorkflowItemKind> = new Set([
  "commentary",
  "approval_request",
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
    if (item.toolName === "multi_edit") {
      continue;
    }
    if (item.kind === "reasoning" || item.kind === "plan") {
      if (
        (item.safeSummary?.trim() || item.text.trim()) &&
        (item.status === "active" || item.status === "completed")
      ) {
        current = createSegment(item);
        segments.push(current);
      }
      continue;
    }

    if (isToolItem(item)) {
      if (
        !current ||
        (current.children.length > 0 &&
          !current.children.some((c) => isToolItem(c)))
      ) {
        current = createSegment(item);
        segments.push(current);
      }
      const children = coalesceRepeatedFileActivity(current.children, item);
      current = {
        key: current.key,
        reasoning: current.reasoning,
        children,
        familyLabels: deriveFamilyLabels(children.slice(0, -1), item),
        isActive: current.isActive || item.status === "active",
      };
      segments[segments.length - 1] = current;
      continue;
    }

    if (HARD_BOUNDARY_KINDS.has(item.kind)) {
      current = null;
      segments.push(createStandaloneSegment(item));
      continue;
    }

    current = null;
  }

  return segments;
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
    case "approval_request":
      return "approval";
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
  const labels = segment.familyLabels;
  if (labels.length === 0) {
    return segment.reasoning?.safeSummary?.trim() || "Thinking";
  }
  return labels.map(toActivityPhrase).join(", ");
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
    case "approval":
      return "requested approval";
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
