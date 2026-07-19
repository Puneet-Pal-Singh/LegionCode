import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_PART_KINDS,
  TOOL_ACTIVITY_FAMILIES,
  type ActivityFeedSnapshot,
} from "@repo/shared-types";
import { ActivityFeed } from "./ActivityFeed.js";

describe("ActivityFeed", () => {
  it("renders collapsed turn summaries and expands grouped exploration rows", () => {
    const onUsePlanInBuild = vi.fn();
    render(
      <ActivityFeed
        feed={createFeedSnapshot()}
        isLoading={false}
        onUsePlanInBuild={onUsePlanInBuild}
      />,
    );

    expect(
      screen.getByRole("button", { name: /worked for 3s/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /worked for 3s/i }));
    expect(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Read README.md")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    );
    expect(screen.getByText("Read README.md")).toBeInTheDocument();
    expect(screen.getByText("Build Handoff")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Execute Plan in Build" }),
    );
    expect(onUsePlanInBuild).toHaveBeenCalledTimes(1);
  });

  it("renders active turns as an open transcript instead of a worked summary", () => {
    render(
      <ActivityFeed
        feed={{
          ...createFeedSnapshot(),
          status: "RUNNING",
          items: [
            ...createFeedSnapshot().items,
            {
              id: "reasoning-1",
              runId: "run-1",
              sessionId: "session-1",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.REASONING,
              createdAt: "2026-03-24T10:00:03.500Z",
              updatedAt: "2026-03-24T10:00:03.500Z",
              source: "brain",
              label: "Analyzing repository",
              summary: "Inspecting the repository before the next tool call.",
              phase: "planning",
              status: "active",
            },
          ],
        }}
        isLoading={true}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /worked for/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/working for/i)).toBeInTheDocument();
    expect(screen.queryByText("Analyzing repository")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Inspecting the repository before the next tool call."),
    ).not.toBeInTheDocument();
  });

  it("resets expansion state when the feed switches to a new run", () => {
    const { rerender } = render(
      <ActivityFeed feed={createFeedSnapshot()} isLoading={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for 3s/i }));
    expect(screen.getByText("Explored 1 list, 1 file")).toBeInTheDocument();

    rerender(
      <ActivityFeed
        feed={{
          ...createFeedSnapshot(),
          runId: "run-2",
          items: createFeedSnapshot().items.map((item) => ({
            ...item,
            runId: "run-2",
          })),
        }}
        isLoading={false}
      />,
    );

    expect(screen.queryByText("Explored 1 list, 1 file")).not.toBeInTheDocument();
  });

  it("renders completed exploration rows as collapsible transcript items", () => {
    render(<ActivityFeed feed={createFeedSnapshot()} isLoading={false} />);

    fireEvent.click(screen.getByRole("button", { name: /worked for 3s/i }));

    expect(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Read README.md")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    );

    expect(screen.getByText("Read README.md")).toBeInTheDocument();
  });

  it("removes stale thinking rows from completed turns and keeps exploration children visible", () => {
    render(
      <ActivityFeed
        feed={{
          runId: "run-explore-thinking",
          sessionId: "session-explore-thinking",
          status: "COMPLETED",
          items: [
            {
              id: "text-1",
              runId: "run-explore-thinking",
              sessionId: "session-explore-thinking",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TEXT,
              createdAt: "2026-03-24T10:00:00.000Z",
              updatedAt: "2026-03-24T10:00:00.000Z",
              source: "brain",
              role: "user",
              content: "inspect the footer",
            },
            {
              id: "reasoning-1",
              runId: "run-explore-thinking",
              sessionId: "session-explore-thinking",
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
              id: "tool-1",
              runId: "run-explore-thinking",
              sessionId: "session-explore-thinking",
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
                count: 2,
                truncated: false,
                preview: "components\nlayout",
                loadedPaths: ["./src"],
                path: "./src",
              },
            },
            {
              id: "reasoning-2",
              runId: "run-explore-thinking",
              sessionId: "session-explore-thinking",
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
              id: "tool-2",
              runId: "run-explore-thinking",
              sessionId: "session-explore-thinking",
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
                preview: "footer",
                loadedPaths: ["./src/components/layout/Footer.tsx"],
                path: "./src/components/layout/Footer.tsx",
              },
            },
          ],
        }}
        isLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for \d+s/i }));
    expect(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("List ./src")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Explored 1 list, 1 file/i }),
    );
    expect(screen.getByText("List ./src")).toBeInTheDocument();
    expect(
      screen.getByText("Read ./src/components/layout/Footer.tsx"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });

  it("hides thinking once live commentary or exploration work has taken over", () => {
    render(
      <ActivityFeed
        feed={{
          runId: "run-live-commentary",
          sessionId: "session-live-commentary",
          status: "RUNNING",
          items: [
            {
              id: "text-1",
              runId: "run-live-commentary",
              sessionId: "session-live-commentary",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TEXT,
              createdAt: "2026-03-24T10:00:00.000Z",
              updatedAt: "2026-03-24T10:00:00.000Z",
              source: "brain",
              role: "user",
              content: "inspect the footer",
            },
            {
              id: "reasoning-1",
              runId: "run-live-commentary",
              sessionId: "session-live-commentary",
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
              runId: "run-live-commentary",
              sessionId: "session-live-commentary",
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
              id: "tool-1",
              runId: "run-live-commentary",
              sessionId: "session-live-commentary",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TOOL,
              createdAt: "2026-03-24T10:00:02.000Z",
              updatedAt: "2026-03-24T10:00:02.000Z",
              source: "brain",
              toolId: "tool-1",
              toolName: "read_file",
              status: "running",
              metadata: {
                family: TOOL_ACTIVITY_FAMILIES.READ,
                count: 1,
                truncated: false,
                preview: "footer",
                loadedPaths: ["./src/components/layout/Footer.tsx"],
                path: "./src/components/layout/Footer.tsx",
              },
            },
          ],
        }}
        isLoading={true}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText("Checking the footer before I make the edit.")).toBeInTheDocument();
    expect(
      screen.getByText("Read ./src/components/layout/Footer.tsx"),
    ).toBeInTheDocument();
  });

  it("renders git status rows as compact transcript lines", () => {
    render(
      <ActivityFeed
        feed={{
          runId: "run-git",
          sessionId: "session-git",
          status: "COMPLETED",
          items: [
            {
              id: "text-1",
              runId: "run-git",
              sessionId: "session-git",
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
              runId: "run-git",
              sessionId: "session-git",
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
        }}
        isLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for \d+s/i }));
    expect(screen.getByText("git status")).toBeInTheDocument();
    expect(screen.queryByText(/\$ git status/)).not.toBeInTheDocument();
  });

  it("renders recoverable assistant updates from activity metadata", () => {
    render(
      <ActivityFeed
        feed={{
          runId: "run-timeout",
          sessionId: "session-timeout",
          status: "COMPLETED",
          items: [
            {
              id: "text-1",
              runId: "run-timeout",
              sessionId: "session-timeout",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TEXT,
              createdAt: "2026-03-24T10:00:00.000Z",
              updatedAt: "2026-03-24T10:00:00.000Z",
              source: "brain",
              role: "user",
              content: "update the footer",
            },
            {
              id: "text-2",
              runId: "run-timeout",
              sessionId: "session-timeout",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TEXT,
              createdAt: "2026-03-24T10:00:01.000Z",
              updatedAt: "2026-03-24T10:00:01.000Z",
              source: "brain",
              role: "assistant",
              content:
                "The model timed out before choosing the next action.\nNo file was changed before the timeout.",
              metadata: {
                code: "TASK_EXECUTION_TIMEOUT",
                retryable: true,
                resumeHint:
                  "Retry the task or switch to a faster or more reliable model.",
                resumeActions: ["retry", "switch_model"],
              },
            },
          ],
        }}
        isLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for \d+s/i }));
    expect(screen.getByText("Recoverable timeout")).toBeInTheDocument();
    expect(
      screen.getByText(/Retry the task or switch to a faster or more reliable model\./i),
    ).toBeInTheDocument();
  });

  it("renders model-stall recovery updates from activity metadata", () => {
    render(
      <ActivityFeed
        feed={{
          runId: "run-model-stall",
          sessionId: "session-model-stall",
          status: "COMPLETED",
          items: [
            {
              id: "text-1",
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
              id: "text-2",
              runId: "run-model-stall",
              sessionId: "session-model-stall",
              turnId: "turn-1",
              kind: ACTIVITY_PART_KINDS.TEXT,
              createdAt: "2026-03-24T10:00:01.000Z",
              updatedAt: "2026-03-24T10:00:01.000Z",
              source: "brain",
              role: "assistant",
              content:
                "The model did not return a usable next action for this edit request.\nNo file was changed in this run.",
              metadata: {
                code: "TASK_MODEL_NO_ACTION",
                retryable: true,
                resumeHint:
                  "Retry the task or switch to a faster or more reliable model.",
                resumeActions: ["retry", "switch_model"],
              },
            },
          ],
        }}
        isLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /worked for \d+s/i }));
    expect(screen.getByText("Model stalled")).toBeInTheDocument();
    expect(
      screen.getByText(/Retry the task or switch to a faster or more reliable model\./i),
    ).toBeInTheDocument();
  });
});

function createFeedSnapshot(): ActivityFeedSnapshot {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "COMPLETED",
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
        content: "Inspect the project.",
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
        id: "handoff-1",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: ACTIVITY_PART_KINDS.HANDOFF,
        createdAt: "2026-03-24T10:00:03.000Z",
        updatedAt: "2026-03-24T10:00:03.000Z",
        source: "brain",
        targetMode: "build",
        summary: "Switch to build mode.",
        prompt: "Execute the approved plan.",
        status: "ready",
      },
    ],
  };
}
