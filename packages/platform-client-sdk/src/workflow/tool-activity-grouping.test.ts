import { describe, expect, it } from "vitest";
import type { ItemId } from "@repo/platform-protocol";
import { groupToolActivity } from "./tool-activity-grouping.js";
import type { WorkflowItem } from "./turn-workflow-projection.js";

describe("groupToolActivity", () => {
  it("keeps approval events out of tool activity presentation", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_read" as ItemId,
        kind: "tool_call",
        toolFamily: "read",
      }),
      workflowItem({
        itemId: "item_approval" as ItemId,
        kind: "approval_request",
        toolFamily: null,
      }),
      workflowItem({
        itemId: "item_write" as ItemId,
        kind: "tool_call",
        toolFamily: "edit",
      }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.children.map((item) => item.itemId)).toEqual([
      "item_read",
    ]);
    expect(segments[1]?.children.map((item) => item.itemId)).toEqual([
      "item_write",
    ]);
  });
});

function workflowItem(
  overrides: Pick<WorkflowItem, "itemId" | "kind" | "toolFamily">,
): WorkflowItem {
  return {
    itemId: overrides.itemId,
    kind: overrides.kind,
    toolFamily: overrides.toolFamily,
    status: "completed",
    sequence: 1,
    text: "",
    detail: null,
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
    startedAt: "2026-08-09T12:00:00.000Z",
    completedAt: "2026-08-09T12:00:01.000Z",
  };
}
