import type { WorkflowItem, WorkflowItemKind } from "./turn-workflow-projection.js";

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
): readonly ToolActivitySegment[] {
  const segments: ToolActivitySegment[] = [];
  let current: ToolActivitySegment | null = null;

  for (const item of items) {
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
        current.children.length > 0 &&
        !current.children.some((c) => isToolItem(c))
      ) {
        current = createSegment(item);
        segments.push(current);
      }
      current = {
        key: current.key,
        reasoning: current.reasoning,
        children: [...current.children, item],
        familyLabels: deriveFamilyLabels(current.children, item),
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
  return item.toolFamily ?? "tool calls";
}

export function buildSegmentTitle(
  segment: ToolActivitySegment,
): string {
  if (segment.reasoning?.text) {
    return segment.reasoning.text;
  }
  const labels = segment.familyLabels;
  if (labels.length === 0) return "Working";
  if (labels.length === 1) return labels[0] ?? "Working";
  return labels.join(", ");
}
