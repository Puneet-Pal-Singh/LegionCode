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

  it("keeps verbose grouped commentary collapsed until requested", () => {
    const item = {
      itemId: ItemIdSchema.parse("itm_commentary001"),
      sequence: 1,
      kind: "commentary" as const,
      status: "completed" as const,
      text: "I am checking the repository first.",
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
            key: "commentary-group",
            reasoning: null,
            familyLabels: ["ran commands"],
            isActive: false,
            children: [
              item,
              {
                ...item,
                itemId: ItemIdSchema.parse("itm_commentary002"),
                sequence: 2,
                kind: "tool_call" as const,
                text: "",
                toolFamily: "shell" as const,
                toolName: "run_command",
                command: "git status --short",
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState={false}
      />,
    );

    const disclosure = screen.getByTestId("activity-disclosure-row");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("I am checking the repository first."),
    ).not.toBeInTheDocument();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("I am checking the repository first."),
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

    const disclosure = screen.getByRole("button", {
      name: /reading src\/main\.ts/i,
    });
    const chevron = screen.getByTestId("activity-disclosure-chevron");
    expect(screen.getByText("Reading src/main.ts")).toHaveClass(
      "turn-lifecycle-shimmer",
    );
    expect(chevron).not.toHaveClass("rotate-90");
    expect(screen.getAllByText("Reading src/main.ts")).toHaveLength(1);
    fireEvent.click(disclosure);
    expect(chevron).toHaveClass("rotate-90");
    const childRow = screen
      .getAllByText("Reading src/main.ts")
      .map((element) => element.closest("[data-item-id]"))
      .find(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
    expect(childRow).toHaveClass("min-h-6", "py-0.5", "text-sm", "leading-5");
    expect(disclosure.parentElement?.querySelector(".border-l")).toBeNull();
    expect(screen.getByTestId("activity-disclosure-row")).toHaveClass(
      "min-h-8",
      "py-1.5",
      "leading-5",
    );
    expect(screen.getByTestId("workflow-tool-viewport")).toHaveClass(
      "space-y-3",
    );
    const expandedChildren =
      disclosure.parentElement?.querySelector(".min-w-0");
    expect(expandedChildren).toHaveClass("min-w-0");
    expect(expandedChildren).not.toHaveClass("mt-1", "py-1");
  });

  it("uses the reasoning title as a visible parent for one active child", () => {
    const tool = {
      itemId: ItemIdSchema.parse("itm_reasoningchild"),
      sequence: 2,
      kind: "tool_call" as const,
      status: "active" as const,
      text: "",
      detail: null,
      toolFamily: "read" as const,
      safeSummary: "Read registry.ts",
      inputSummary: null,
      outputSummary: null,
      toolName: "read_file",
      filePath: "registry.ts",
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
            key: "reasoning-parent",
            reasoning: {
              ...tool,
              itemId: ItemIdSchema.parse("itm_reasoning"),
              sequence: 1,
              kind: "plan" as const,
              toolFamily: null,
              safeSummary: "Planning legacy provider separation",
              filePath: null,
              toolName: null,
              status: "active" as const,
            },
            familyLabels: ["read"],
            isActive: true,
            children: [tool],
          },
        ]}
        turnDiff={null}
        showThinkingState={true}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /reading registry\.ts/i,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: /reading registry\.ts/i,
    }));
    expect(
      screen.getByRole("button", {
        name: /view details for reading registry\.ts/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-workflow-title")).toHaveTextContent(
      "Reading registry.ts",
    );
    expect(screen.getByTestId("active-workflow-title")).toHaveClass(
      "turn-lifecycle-shimmer",
    );
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });

  it("promotes one active tool into the stable parent disclosure", () => {
    const tool = {
      itemId: ItemIdSchema.parse("itm_single_active"),
      sequence: 1,
      kind: "tool_call" as const,
      status: "active" as const,
      text: "",
      detail: null,
      toolFamily: "shell" as const,
      safeSummary: "Run pnpm test",
      inputSummary: null,
      outputSummary: null,
      toolName: "bash",
      filePath: null,
      command: "pnpm test",
      outputContent: "still running",
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
            key: "single-active-tool",
            reasoning: null,
            familyLabels: ["shell"],
            isActive: true,
            children: [tool],
          },
        ]}
        turnDiff={null}
        showThinkingState
      />,
    );

    expect(
      screen.getByRole("button", { name: /running pnpm test/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: /running pnpm test/i,
    }));
    expect(screen.getByText("Running command")).toHaveClass(
      "turn-lifecycle-shimmer",
    );
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });

  it("keeps one active title node mounted as thinking becomes tool activity", () => {
    const { rerender } = render(
      <WorkflowTimeline segments={[]} turnDiff={null} showThinkingState />,
    );
    const activeTitle = screen.getByTestId("active-workflow-title");
    const activeDisclosure = screen.getByTestId("activity-disclosure-row");
    expect(activeTitle).toHaveTextContent("Thinking through the next step");
    expect(activeTitle).toHaveClass("turn-lifecycle-shimmer");

    rerender(
      <WorkflowTimeline
        segments={[
          {
            key: "visible-commentary",
            reasoning: null,
            familyLabels: ["tool calls"],
            isActive: false,
            children: [
              {
                itemId: ItemIdSchema.parse("itm_commentary"),
                sequence: 1,
                kind: "commentary",
                status: "completed",
                text: "I’m checking the test suite now.",
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
                editChange: undefined,
                planSteps: [],
                compactionPhase: null,
                startedAt: "2026-08-09T09:59:59.000Z",
                completedAt: "2026-08-09T10:00:00.000Z",
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState
      />,
    );

    expect(screen.getByTestId("active-workflow-title")).toBe(activeTitle);
    expect(screen.getByTestId("activity-disclosure-row")).toBe(
      activeDisclosure,
    );
    fireEvent.click(screen.getByTestId("activity-disclosure-row"));
    expect(activeTitle).toHaveTextContent("Thinking through the next step");
    expect(
      screen.getAllByText("I’m checking the test suite now."),
    ).toHaveLength(1);

    rerender(
      <WorkflowTimeline
        segments={[
          {
            key: "visible-commentary",
            reasoning: null,
            familyLabels: ["tool calls"],
            isActive: false,
            children: [
              {
                itemId: ItemIdSchema.parse("itm_commentary"),
                sequence: 1,
                kind: "commentary",
                status: "completed",
                text: "I’m checking the test suite now.",
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
                editChange: undefined,
                planSteps: [],
                compactionPhase: null,
                startedAt: "2026-08-09T09:59:59.000Z",
                completedAt: "2026-08-09T10:00:00.000Z",
              },
            ],
          },
          {
            key: "active-command",
            reasoning: null,
            familyLabels: ["shell"],
            isActive: true,
            children: [
              {
                itemId: ItemIdSchema.parse("itm_completed_read"),
                sequence: 2,
                kind: "tool_call",
                status: "completed",
                text: "",
                detail: null,
                toolFamily: "read",
                safeSummary: "Read package.json",
                inputSummary: null,
                outputSummary: null,
                toolName: "read_file",
                filePath: "package.json",
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
              },
              {
                itemId: ItemIdSchema.parse("itm_continuous"),
                sequence: 3,
                kind: "command_execution",
                status: "active",
                text: "",
                detail: null,
                toolFamily: "shell",
                safeSummary: "Run tests",
                inputSummary: null,
                outputSummary: null,
                toolName: "bash",
                filePath: null,
                command: "pnpm test",
                outputContent: null,
                diffPreview: null,
                additions: null,
                deletions: null,
                editChange: undefined,
                planSteps: [],
                compactionPhase: null,
                startedAt: "2026-08-09T10:00:00.000Z",
                completedAt: null,
              },
            ],
          },
        ]}
        turnDiff={null}
        showThinkingState
      />,
    );

    expect(screen.getByTestId("active-workflow-title")).toBe(activeTitle);
    expect(screen.getByTestId("activity-disclosure-row")).toBe(
      activeDisclosure,
    );
    expect(screen.getAllByTestId("activity-disclosure-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("activity-disclosure-row"));
    expect(activeTitle).toHaveTextContent("Running pnpm test");
    expect(activeTitle).toHaveClass("turn-lifecycle-shimmer");
    expect(
      screen.getByText("I’m checking the test suite now."),
    ).toBeInTheDocument();
    expect(screen.getByText("Running command")).toHaveClass(
      "turn-lifecycle-shimmer",
    );
    expect(screen.getByText("Read package.json")).toBeInTheDocument();
    expect(screen.getByText("Read package.json")).not.toHaveClass(
      "turn-lifecycle-shimmer",
    );

    rerender(
      <WorkflowTimeline
        segments={[]}
        turnDiff={null}
        showThinkingState={false}
      />,
    );
    expect(screen.queryByTestId("active-workflow-title")).toBeNull();
  });
});
