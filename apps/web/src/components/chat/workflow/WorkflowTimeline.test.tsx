import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemIdSchema } from "@repo/platform-client-sdk";
import { WorkflowTimeline } from "./WorkflowTimeline.js";

describe("WorkflowTimeline", () => {
  it("labels a classified write as a created-file activity", () => {
    render(
      <WorkflowTimeline
        segments={[
          {
            key: "created-file",
            reasoning: null,
            familyLabels: ["edited files"],
            isActive: false,
            children: [
              {
                itemId: ItemIdSchema.parse("itm_created01"),
                sequence: 1,
                kind: "tool_call",
                status: "completed",
                text: "",
                detail: null,
                toolFamily: "edit",
                safeSummary: null,
                inputSummary: null,
                outputSummary: null,
                toolName: "write_file",
                filePath: "src/new-file.ts",
                command: null,
                outputContent: null,
                diffPreview: "+export {};",
                additions: 1,
                deletions: 0,
                editChange: "created",
                planSteps: [],
                compactionPhase: null,
                startedAt: "2026-08-09T10:00:00.000Z",
                completedAt: "2026-08-09T10:00:01.000Z",
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^edited files$/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Created src/new-file.ts")).toBeInTheDocument();
  });

  it("keeps a summary disclosure for multiple tool calls", () => {
    const tool = {
      itemId: ItemIdSchema.parse("itm_grouped01"),
      sequence: 1,
      kind: "tool_call" as const,
      status: "completed" as const,
      text: "",
      detail: null,
      toolFamily: "search" as const,
      safeSummary: null,
      inputSummary: null,
      outputSummary: null,
      toolName: "list_files",
      filePath: null,
      command: null,
      outputContent: null,
      diffPreview: null,
      additions: null,
      deletions: null,
      editChange: undefined,
      planSteps: [],
      compactionPhase: null,
      startedAt: "2026-08-09T10:00:00.000Z",
      completedAt: "2026-08-09T10:00:01.000Z",
    };
    render(
      <WorkflowTimeline
        segments={[
          {
            key: "grouped-tools",
            reasoning: null,
            familyLabels: ["searched files"],
            isActive: false,
            children: [
              tool,
              {
                ...tool,
                itemId: ItemIdSchema.parse("itm_grouped02"),
                sequence: 2,
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: /searched files/i }),
    ).toBeInTheDocument();
  });

  it("shimmers active grouped work and aligns its children with the parent", () => {
    const tool = {
      itemId: ItemIdSchema.parse("itm_active001"),
      sequence: 1,
      kind: "tool_call" as const,
      status: "active" as const,
      text: "",
      detail: null,
      toolFamily: "read" as const,
      safeSummary: null,
      inputSummary: null,
      outputSummary: null,
      toolName: "read_file",
      filePath: "src/main.ts",
      command: null,
      outputContent: null,
      diffPreview: null,
      additions: null,
      deletions: null,
      editChange: undefined,
      planSteps: [],
      compactionPhase: null,
      startedAt: "2026-08-09T10:00:00.000Z",
      completedAt: null,
    };
    render(
      <WorkflowTimeline
        segments={[
          {
            key: "active-tools",
            reasoning: null,
            familyLabels: ["read files"],
            isActive: true,
            children: [
              tool,
              {
                ...tool,
                itemId: ItemIdSchema.parse("itm_active002"),
                sequence: 2,
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState={false}
      />,
    );

    const disclosure = screen.getByRole("button", { name: /read files/i });
    const chevron = screen.getByTestId("activity-disclosure-chevron");
    expect(screen.getByText("used read files")).toHaveClass(
      "turn-lifecycle-shimmer",
    );
    expect(chevron).not.toHaveClass("rotate-90");
    fireEvent.click(disclosure);
    expect(chevron).toHaveClass("rotate-90");
    expect(disclosure.parentElement?.querySelector(".border-l")).toBeNull();
    expect(screen.getByTestId("activity-disclosure-row")).toHaveClass(
      "min-h-7",
      "py-1",
      "leading-5",
    );
    expect(
      screen.getAllByText("Reading src/main.ts")[0]?.closest("[data-item-id]"),
    ).toHaveClass("py-1", "text-sm", "leading-5");
    expect(screen.getByTestId("workflow-tool-viewport")).toHaveClass(
      "space-y-1",
    );
    const expandedChildren = disclosure.parentElement?.querySelector(
      ".min-w-0",
    );
    expect(expandedChildren).toHaveClass("min-w-0");
    expect(expandedChildren).not.toHaveClass("mt-1", "py-1");
  });
});
