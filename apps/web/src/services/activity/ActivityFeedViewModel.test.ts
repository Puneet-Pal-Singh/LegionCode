import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_PART_KINDS,
  TOOL_ACTIVITY_FAMILIES,
  type ActivityFeedSnapshot,
} from "@repo/shared-types";
import { buildActivityFeedViewModel } from "./ActivityFeedViewModel.js";

describe("ActivityFeedViewModel", () => {
  it("groups low-noise exploration actions and builds collapsed turn summaries", () => {
    const viewModel = buildActivityFeedViewModel(createFeedSnapshot());
    expect(viewModel.turns).toHaveLength(1);
    expect(viewModel.turns[0]?.summaryLabel).toBe(
      "3 tool calls · 1 progress update",
    );
    expect(viewModel.turns[0]?.defaultCollapsed).toBe(false);
    expect(viewModel.turns[0]?.isActiveTurn).toBe(true);
    expect(viewModel.turns[0]?.rows[0]).toMatchObject({
      kind: "reasoning",
      label: "Analyzing request",
    });
    expect(viewModel.turns[0]?.rows[1]?.kind).toBe("group");
    expect(viewModel.turns[0]?.rows[1]).toMatchObject({
      kind: "group",
      title: "Explored",
      summary: "1 list, 1 file",
    });
    expect(viewModel.turns[0]?.rows[2]?.kind).toBe("tool");
    if (viewModel.turns[0]?.rows[2]?.kind === "tool") {
      expect(viewModel.turns[0].rows[2].family).toBe(
        TOOL_ACTIVITY_FAMILIES.SHELL,
      );
    }
  });

  it("marks completed turns as non-active and collapsed by default", () => {
    const viewModel = buildActivityFeedViewModel({
      ...createFeedSnapshot(),
      status: "COMPLETED",
    });

    expect(viewModel.turns[0]?.isActiveTurn).toBe(false);
    expect(viewModel.turns[0]?.defaultCollapsed).toBe(true);
  });

  it("uses wall-clock time for active turn elapsed labels", () => {
    const nowMs = Date.parse("2026-03-24T10:01:20.000Z");
    const viewModel = buildActivityFeedViewModel(
      {
        runId: "run-live-elapsed",
        sessionId: "session-live-elapsed",
        status: "RUNNING",
        items: [
          {
            id: "text-user",
            runId: "run-live-elapsed",
            sessionId: "session-live-elapsed",
            turnId: "turn-1",
            kind: ACTIVITY_PART_KINDS.TEXT,
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "yo",
          },
        ],
      },
      nowMs,
    );

    expect(viewModel.turns[0]?.elapsedLabel).toBe("Working for 1m 20s");
  });

  it("labels active read batches with specific progress copy", () => {
    const snapshot = createFeedSnapshot();
    const runningTool = snapshot.items[3];
    if (!runningTool || runningTool.kind !== ACTIVITY_PART_KINDS.TOOL) {
      throw new Error("Expected a tool activity fixture.");
    }
    const viewModel = buildActivityFeedViewModel({
      ...snapshot,
      items: [
        snapshot.items[0]!,
        snapshot.items[1]!,
        snapshot.items[2]!,
        {
          ...runningTool,
          id: "tool-2-running",
          status: "running",
          updatedAt: "2026-03-24T10:00:02.500Z",
        },
      ],
    });

    expect(viewModel.turns[0]?.rows[1]).toMatchObject({
      kind: "group",
      title: "Exploring",
      summary: "1 list, 1 file",
      status: "running",
      defaultCollapsed: false,
    });
  });

  it("keeps exploring rows grouped when generic thinking updates are interleaved", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-explore-group",
      sessionId: "session-explore-group",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-explore-group",
          sessionId: "session-explore-group",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "inspect the footer",
        },
        {
          id: "thinking-1",
          runId: "run-explore-group",
          sessionId: "session-explore-group",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:00.500Z",
          updatedAt: "2026-03-24T10:00:00.500Z",
          source: "brain",
          label: "Thinking",
          summary: "",
          phase: "execution",
          status: "active",
        },
        {
          id: "tool-list",
          runId: "run-explore-group",
          sessionId: "session-explore-group",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          toolId: "tool-list",
          toolName: "list_files",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.READ,
            count: 3,
            truncated: false,
            preview: "src\nREADME.md",
            loadedPaths: ["src"],
            path: "./src",
          },
        },
        {
          id: "thinking-2",
          runId: "run-explore-group",
          sessionId: "session-explore-group",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:01.500Z",
          updatedAt: "2026-03-24T10:00:01.500Z",
          source: "brain",
          label: "Thinking",
          summary: "",
          phase: "execution",
          status: "active",
        },
        {
          id: "tool-read",
          runId: "run-explore-group",
          sessionId: "session-explore-group",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          toolId: "tool-read",
          toolName: "read_file",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.READ,
            count: 1,
            truncated: false,
            preview: "footer content",
            loadedPaths: ["./src/components/layout/Footer.tsx"],
            path: "./src/components/layout/Footer.tsx",
          },
        },
      ],
    });

    expect(viewModel.turns[0]?.rows).toEqual([
      expect.objectContaining({
        kind: "group",
        title: "Explored",
        summary: "1 list, 1 file",
        rows: expect.arrayContaining([
          expect.objectContaining({ title: "List ./src" }),
          expect.objectContaining({
            title: "Read ./src/components/layout/Footer.tsx",
          }),
        ]),
      }),
    ]);
  });

  it("turns generic execution progress into a compact thinking row and suppresses generic synthesis rows", () => {
    const snapshot = createFeedSnapshot();
    const viewModel = buildActivityFeedViewModel({
      ...snapshot,
      items: [
        ...snapshot.items,
        {
          id: "reasoning-execution",
          runId: "run-1",
          sessionId: "session-1",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:04.000Z",
          updatedAt: "2026-03-24T10:00:04.000Z",
          source: "brain",
          label: "Executing tools",
          summary: "Running the selected coding tools.",
          phase: "execution",
          status: "completed",
        },
        {
          id: "reasoning-synthesis",
          runId: "run-1",
          sessionId: "session-1",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:05.000Z",
          updatedAt: "2026-03-24T10:00:05.000Z",
          source: "brain",
          label: "Preparing final answer",
          summary: "Summarizing execution results for the final response.",
          phase: "synthesis",
          status: "completed",
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.some(
        (row) => row.kind === "reasoning" && row.label === "Thinking",
      ),
    ).toBe(false);
    expect(
      viewModel.turns[0]?.rows.some(
        (row) =>
          row.kind === "reasoning" &&
          row.summary ===
            "Summarizing execution results for the final response.",
      ),
    ).toBe(false);
  });

  it("renders thinking only while it remains the latest unresolved state", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-active-thinking",
      sessionId: "session-active-thinking",
      status: "RUNNING",
      items: [
        {
          id: "text-user",
          runId: "run-active-thinking",
          sessionId: "session-active-thinking",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "inspect the footer",
        },
        {
          id: "tool-read",
          runId: "run-active-thinking",
          sessionId: "session-active-thinking",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          toolId: "tool-read",
          toolName: "read_file",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.READ,
            count: 1,
            truncated: false,
            preview: "footer content",
            loadedPaths: ["./src/components/layout/Footer.tsx"],
            path: "./src/components/layout/Footer.tsx",
          },
        },
        {
          id: "thinking-1",
          runId: "run-active-thinking",
          sessionId: "session-active-thinking",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:01.500Z",
          updatedAt: "2026-03-24T10:00:01.500Z",
          source: "brain",
          label: "Thinking",
          summary: "",
          phase: "execution",
          status: "active",
        },
        {
          id: "thinking-2",
          runId: "run-active-thinking",
          sessionId: "session-active-thinking",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          label: "Thinking",
          summary: "",
          phase: "execution",
          status: "active",
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.filter(
        (row) => row.kind === "reasoning" && row.label === "Thinking",
      ),
    ).toHaveLength(1);
  });

  it("surfaces the plugin badge label for dedicated git tool rows", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-git-plugin",
      sessionId: "session-git-plugin",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-git-plugin",
          sessionId: "session-git-plugin",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "commit the changes",
        },
        {
          id: "tool-git-commit",
          runId: "run-git-plugin",
          sessionId: "session-git-plugin",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          toolId: "tool-git-commit",
          toolName: "git_commit",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.GIT,
            displayText: "Creating git commit",
            pluginLabel: "GitHub",
            preview:
              "[feat/floating-hero-carousels abc1234] feat: add floating carousels to hero section",
            count: 1,
          },
        },
      ],
    });

    expect(viewModel.turns[0]?.rows[0]).toMatchObject({
      kind: "tool",
      pluginLabel: "GitHub",
      title: "Creating git commit",
    });
  });

  it("drops thinking as soon as commentary or tool work supersedes it", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-thinking-superseded",
      sessionId: "session-thinking-superseded",
      status: "RUNNING",
      items: [
        {
          id: "text-user",
          runId: "run-thinking-superseded",
          sessionId: "session-thinking-superseded",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "inspect the footer",
        },
        {
          id: "thinking-1",
          runId: "run-thinking-superseded",
          sessionId: "session-thinking-superseded",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:00.500Z",
          updatedAt: "2026-03-24T10:00:00.500Z",
          source: "brain",
          label: "Thinking",
          summary: "",
          phase: "execution",
          status: "active",
        },
        {
          id: "commentary-1",
          runId: "run-thinking-superseded",
          sessionId: "session-thinking-superseded",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          phase: "commentary",
          status: "active",
          text: "Checking the footer before I make the edit.",
        },
        {
          id: "tool-read",
          runId: "run-thinking-superseded",
          sessionId: "session-thinking-superseded",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          toolId: "tool-read",
          toolName: "read_file",
          status: "running",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.READ,
            count: 1,
            truncated: false,
            preview: "footer content",
            loadedPaths: ["./src/components/layout/Footer.tsx"],
            path: "./src/components/layout/Footer.tsx",
          },
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.some(
        (row) => row.kind === "reasoning" && row.label === "Thinking",
      ),
    ).toBe(false);
    expect(viewModel.turns[0]?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "commentary",
          text: "Checking the footer before I make the edit.",
        }),
        expect.objectContaining({
          kind: "tool",
          title: "Read ./src/components/layout/Footer.tsx",
          status: "running",
        }),
      ]),
    );
  });

  it("keeps explicit execution progress rows and recovery-coded assistant messages visible", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-progress",
      sessionId: "session-progress",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-progress",
          sessionId: "session-progress",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "update the footer",
        },
        {
          id: "reasoning-progress",
          runId: "run-progress",
          sessionId: "session-progress",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          label: "Thinking",
          summary: "Inspecting the workspace before answering.",
          phase: "execution",
          status: "active",
        },
        {
          id: "text-assistant",
          runId: "run-progress",
          sessionId: "session-progress",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          role: "assistant",
          content: "No file was changed before the timeout.",
          metadata: {
            code: "TASK_EXECUTION_TIMEOUT",
            retryable: true,
            resumeHint: "Retry the task or switch models.",
          },
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.some(
        (row) =>
          row.kind === "reasoning" &&
          row.summary ===
            "Inspecting the workspace before answering.",
      ),
    ).toBe(true);
    expect(
      viewModel.turns[0]?.rows.some(
        (row) =>
          row.kind === "commentary" &&
          row.metadata?.code === "TASK_EXECUTION_TIMEOUT",
      ),
    ).toBe(true);
  });

  it("keeps TASK_MODEL_NO_ACTION assistant messages visible as recovery commentary", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-model-stall",
      sessionId: "session-model-stall",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-model-stall",
          sessionId: "session-model-stall",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "update the footer",
        },
        {
          id: "text-assistant",
          runId: "run-model-stall",
          sessionId: "session-model-stall",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          role: "assistant",
          content:
            "The model did not return a usable next action for this edit request.",
          metadata: {
            code: "TASK_MODEL_NO_ACTION",
            retryable: true,
            resumeHint:
              "Retry the task or switch to a faster or more reliable model.",
          },
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.some(
        (row) =>
          row.kind === "commentary" &&
          row.metadata?.code === "TASK_MODEL_NO_ACTION",
      ),
    ).toBe(true);
  });

  it("renders authored commentary rows faithfully and keeps final answers in the main chat transcript", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-commentary",
      sessionId: "session-commentary",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-commentary",
          sessionId: "session-commentary",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "fix the footer",
        },
        {
          id: "commentary-progress",
          runId: "run-commentary",
          sessionId: "session-commentary",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          phase: "commentary",
          status: "active",
          text: "I'm checking the footer rendering path before I patch it.",
        },
        {
          id: "commentary-final",
          runId: "run-commentary",
          sessionId: "session-commentary",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.COMMENTARY,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          phase: "final_answer",
          status: "completed",
          text: "Footer updated.",
        },
      ],
    });

    expect(viewModel.turns[0]?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "commentary",
          phase: "commentary",
          status: "active",
          text: "I'm checking the footer rendering path before I patch it.",
        }),
      ]),
    );
    expect(
      viewModel.turns[0]?.rows.some(
        (row) => row.kind === "commentary" && row.phase === "final_answer",
      ),
    ).toBe(false);
  });

  it("preserves authored labels when generic reasoning summaries collapse away", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-authored-reasoning",
      sessionId: "session-authored-reasoning",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-authored-reasoning",
          sessionId: "session-authored-reasoning",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "fix the footer",
        },
        {
          id: "reasoning-execution",
          runId: "run-authored-reasoning",
          sessionId: "session-authored-reasoning",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          label: "Checking footer copy",
          summary: "Running the selected coding tools.",
          phase: "execution",
          status: "active",
        },
        {
          id: "reasoning-synthesis",
          runId: "run-authored-reasoning",
          sessionId: "session-authored-reasoning",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.REASONING,
          createdAt: "2026-03-24T10:00:02.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          label: "Reporting what changed",
          summary:
            "Preparing the final user-facing response from the observed results.",
          phase: "synthesis",
          status: "completed",
        },
      ],
    });

    expect(viewModel.turns[0]?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "reasoning",
          label: "Checking footer copy",
          summary: "",
        }),
        expect.objectContaining({
          kind: "reasoning",
          label: "Reporting what changed",
          summary:
            "Preparing the final user-facing response from the observed results.",
        }),
      ]),
    );
  });

  it("keeps plain assistant transcript messages out of the activity feed", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-plain-assistant",
      sessionId: "session-plain-assistant",
      status: "COMPLETED",
      items: [
        {
          id: "text-user",
          runId: "run-plain-assistant",
          sessionId: "session-plain-assistant",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "update the footer",
        },
        {
          id: "text-assistant",
          runId: "run-plain-assistant",
          sessionId: "session-plain-assistant",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          role: "assistant",
          content: "I updated the footer and added the CTA.",
        },
      ],
    });

    expect(
      viewModel.turns[0]?.rows.some(
        (row) => row.kind === "text" || row.kind === "commentary",
      ),
    ).toBe(false);
  });

  it("formats git status activity like a command transcript", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-2",
      sessionId: "session-2",
      status: "COMPLETED",
      items: [
        {
          id: "text-1",
          runId: "run-2",
          sessionId: "session-2",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "check my git info",
        },
        {
          id: "tool-1",
          runId: "run-2",
          sessionId: "session-2",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          toolId: "tool-1",
          toolName: "git_status",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.GIT,
            preview:
              '{"files":[],"ahead":0,"behind":0,"branch":"main","hasStaged":false,"hasUnstaged":false,"gitAvailable":true}',
          },
        },
      ],
    });

    const gitRow = viewModel.turns[0]?.rows[0];
    expect(gitRow).toMatchObject({
      kind: "tool",
      title: "git status",
      summary: "On main · working tree clean",
      defaultCollapsed: false,
    });

    if (gitRow?.kind === "tool") {
      expect(gitRow.details[0]).toContain("$ git status");
      expect(gitRow.details[0]).toContain("On branch main");
      expect(gitRow.details[0]).toContain("Working tree clean.");
    }
  });

  it("suppresses granted approvals from the transcript and summary chips", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-granted-approval",
      sessionId: "session-granted-approval",
      status: "COMPLETED",
      items: [
        {
          id: "text-1",
          runId: "run-granted-approval",
          sessionId: "session-granted-approval",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "check status and continue",
        },
        {
          id: "approval-1",
          runId: "run-granted-approval",
          sessionId: "session-granted-approval",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.APPROVAL,
          createdAt: "2026-03-24T10:00:00.500Z",
          updatedAt: "2026-03-24T10:00:01.000Z",
          source: "brain",
          approvalType: "permission",
          status: "granted",
          summary: "Approval resolved",
          details: "Decision: allow_once",
        },
        {
          id: "tool-1",
          runId: "run-granted-approval",
          sessionId: "session-granted-approval",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.200Z",
          updatedAt: "2026-03-24T10:00:01.500Z",
          source: "brain",
          toolId: "tool-1",
          toolName: "bash",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.SHELL,
            command: "git status --short",
            origin: "agent_tool",
            cwd: ".",
            stdout: "",
            outputTail: "",
            exitCode: 0,
            truncated: false,
          },
        },
      ],
    });

    expect(viewModel.summary.approvalsLabel).toBeNull();
    expect(
      viewModel.turns[0]?.rows.some((row) => row.kind === "approval"),
    ).toBe(false);
  });

  it("skips activity turns that are missing a canonical turn id", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const viewModel = buildActivityFeedViewModel({
      runId: "run-invalid",
      sessionId: "session-invalid",
      status: "COMPLETED",
      items: [
        {
          id: "tool-1",
          runId: "run-invalid",
          sessionId: "session-invalid",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          toolId: "tool-1",
          toolName: "git_status",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.GIT,
            preview:
              '{"files":[],"ahead":0,"behind":0,"branch":"main","hasStaged":false,"hasUnstaged":false,"gitAvailable":true}',
          },
        },
      ],
    });

    expect(viewModel.turns).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[activity/feed] Skipping activity turn without canonical turnId.",
      { index: 0, runId: "run-invalid" },
    );

    warnSpy.mockRestore();
  });

  it("falls back to raw git preview when status files are malformed", () => {
    const viewModel = buildActivityFeedViewModel({
      runId: "run-git-invalid",
      sessionId: "session-git-invalid",
      status: "COMPLETED",
      items: [
        {
          id: "text-1",
          runId: "run-git-invalid",
          sessionId: "session-git-invalid",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TEXT,
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
          source: "brain",
          role: "user",
          content: "check git",
        },
        {
          id: "tool-1",
          runId: "run-git-invalid",
          sessionId: "session-git-invalid",
          turnId: "turn-1",
          kind: ACTIVITY_PART_KINDS.TOOL,
          createdAt: "2026-03-24T10:00:01.000Z",
          updatedAt: "2026-03-24T10:00:02.000Z",
          source: "brain",
          toolId: "tool-1",
          toolName: "git_status",
          status: "completed",
          metadata: {
            family: TOOL_ACTIVITY_FAMILIES.GIT,
            preview:
              '{"files":[{"oops":true}],"ahead":0,"behind":0,"branch":"main","hasStaged":false,"hasUnstaged":false,"gitAvailable":true}',
          },
        },
      ],
    });

    const gitRow = viewModel.turns[0]?.rows[0];
    expect(gitRow).toMatchObject({
      kind: "tool",
      title: "git status",
      summary: "",
    });
    if (gitRow?.kind === "tool") {
      expect(gitRow.details[0]).toContain('"oops":true');
    }
  });
});

function createFeedSnapshot(): ActivityFeedSnapshot {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "RUNNING",
    items: [
      {
        id: "text-1",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.TEXT,
        createdAt: "2026-03-24T10:00:00.000Z",
        updatedAt: "2026-03-24T10:00:00.000Z",
        source: "brain",
        role: "user",
        content: "Inspect the app and run tests.",
      },
      {
        id: "reasoning-1",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.REASONING,
        createdAt: "2026-03-24T10:00:00.500Z",
        updatedAt: "2026-03-24T10:00:00.500Z",
        source: "brain",
        label: "Analyzing request",
        summary: "Checking the repository before editing.",
        phase: "planning",
        status: "completed",
      },
      {
        id: "tool-1",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.TOOL,
        createdAt: "2026-03-24T10:00:01.000Z",
        updatedAt: "2026-03-24T10:00:01.000Z",
        source: "brain",
        toolId: "tool-1",
        toolName: "list_files",
        status: "completed",
        metadata: {
          family: TOOL_ACTIVITY_FAMILIES.READ,
          count: 3,
          truncated: false,
          preview: "src\nREADME.md",
          loadedPaths: ["."],
          path: ".",
        },
      },
      {
        id: "tool-2",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.TOOL,
        createdAt: "2026-03-24T10:00:02.000Z",
        updatedAt: "2026-03-24T10:00:02.000Z",
        source: "brain",
        toolId: "tool-2",
        toolName: "read_file",
        status: "completed",
        metadata: {
          family: TOOL_ACTIVITY_FAMILIES.READ,
          count: 1,
          truncated: false,
          preview: "content",
          loadedPaths: ["README.md"],
          path: "README.md",
        },
      },
      {
        id: "tool-3",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.TOOL,
        createdAt: "2026-03-24T10:00:03.000Z",
        updatedAt: "2026-03-24T10:00:03.000Z",
        source: "brain",
        toolId: "tool-3",
        toolName: "bash",
        status: "completed",
        metadata: {
          family: TOOL_ACTIVITY_FAMILIES.SHELL,
          command: "pnpm test",
          origin: "agent_tool",
          cwd: ".",
          stdout: "ok",
          outputTail: "ok",
          exitCode: 0,
          truncated: false,
        },
      },
    ],
  };
}
