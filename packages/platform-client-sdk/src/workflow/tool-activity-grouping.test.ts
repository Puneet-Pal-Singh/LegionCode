import { describe, expect, it } from "vitest";
import type { ItemId } from "@repo/platform-protocol";
import {
  buildSegmentTitle,
  groupToolActivity,
} from "./tool-activity-grouping.js";
import type { WorkflowItem } from "./turn-workflow-projection.js";

describe("groupToolActivity", () => {
  it("prefers active display-safe tool titles over reasoning and keeps them concise", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_plan" as ItemId,
        kind: "plan",
        toolFamily: null,
        status: "active",
        safeSummary: "Planning legacy provider separation",
      }),
      workflowItem({
        itemId: "item_shell" as ItemId,
        kind: "tool_call",
        toolFamily: "shell",
        status: "active",
        safeSummary: "Run git status --short and inspect the branch now",
      }),
    ]);

    expect(buildSegmentTitle(segments[0]!)).toBe(
      "Run git status --short and inspect…",
    );
  });

  it("uses visible reasoning as the parent title when no tool is active", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_plan" as ItemId,
        kind: "plan",
        toolFamily: null,
        status: "active",
        safeSummary: "Planning legacy provider separation",
      }),
      workflowItem({
        itemId: "item_shell" as ItemId,
        kind: "tool_call",
        toolFamily: "shell",
      }),
    ]);

    expect(buildSegmentTitle(segments[0]!)).toBe(
      "Planning legacy provider separation",
    );
  });

  it("expands short active labels into a four-to-six-word status", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_read" as ItemId,
        kind: "tool_call",
        toolFamily: "read",
        status: "active",
        safeSummary: "Read registry.ts",
      }),
    ]);

    expect(buildSegmentTitle(segments[0]!)).toBe(
      "Reading the selected source file",
    );
  });

  it("keeps settled groups in the cumulative past tense", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_plan" as ItemId,
        kind: "plan",
        toolFamily: null,
        safeSummary: "Planning the implementation approach",
      }),
      workflowItem({
        itemId: "item_edit" as ItemId,
        kind: "tool_call",
        toolFamily: "edit",
      }),
    ]);

    expect(buildSegmentTitle(segments[0]!)).toBe("edited files");
  });

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

  it("keeps visible commentary as its own chronological segment", () => {
    const segments = groupToolActivity([
      workflowItem({
        itemId: "item_commentary" as ItemId,
        kind: "commentary",
        toolFamily: null,
        text: "I am checking the repository first.",
      }),
      workflowItem({
        itemId: "item_shell" as ItemId,
        kind: "tool_call",
        toolFamily: "shell",
      }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.children[0]).toMatchObject({
      kind: "commentary",
      text: "I am checking the repository first.",
    });
    expect(segments[1]?.children[0]?.kind).toBe("tool_call");
  });
});

function workflowItem(
  overrides: Partial<WorkflowItem> &
    Pick<WorkflowItem, "itemId" | "kind" | "toolFamily">,
): WorkflowItem {
  return {
    itemId: overrides.itemId,
    kind: overrides.kind,
    toolFamily: overrides.toolFamily,
    status: overrides.status ?? "completed",
    sequence: 1,
    text: overrides.text ?? "",
    detail: null,
    safeSummary: overrides.safeSummary ?? null,
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
