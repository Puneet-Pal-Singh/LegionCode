import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityRow } from "./ActivityRow.js";
import type { ActivityFeedRowViewModel } from "../../../services/activity/ActivityFeedViewModel.js";

describe("ActivityRow", () => {
  it("renders commentary rows with the commentary renderer", () => {
    render(
      <ActivityRow
        row={createCommentaryRow({
          text: "Regular assistant response",
        })}
        expanded={true}
        onToggle={vi.fn()}
        displayMode="transcript"
      />,
    );

    expect(screen.getByText("Regular assistant response")).toBeInTheDocument();
    expect(screen.queryByText("Commentary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders recovery commentary rows with the recovery renderer", () => {
    render(
      <ActivityRow
        row={createCommentaryRow({
          text: "The model timed out before choosing the next action.",
          metadata: {
            code: "TASK_EXECUTION_TIMEOUT",
            resumeHint: "Retry the task.",
            resumeActions: ["retry"],
          },
        })}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Recoverable timeout")).toBeInTheDocument();
    expect(screen.getByText(/Retry the task\./i)).toBeInTheDocument();
  });

  it("renders TASK_MODEL_NO_ACTION rows with a non-blaming label", () => {
    render(
      <ActivityRow
        row={createCommentaryRow({
          text: "The model did not return a usable next action for this edit request.",
          metadata: {
            code: "TASK_MODEL_NO_ACTION",
            resumeHint:
              "Retry the task or switch to a faster or more reliable model.",
            resumeActions: ["retry", "switch_model"],
          },
        })}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Model stalled")).toBeInTheDocument();
    expect(
      screen.getByText(/Retry the task or switch to a faster or more reliable model\./i),
    ).toBeInTheDocument();
  });

  it("renders TOOL_EXECUTION_FAILED rows with a user-facing recovery label", () => {
    render(
      <ActivityRow
        row={createCommentaryRow({
          text: "A shell step failed.",
          metadata: {
            code: "TOOL_EXECUTION_FAILED",
            resumeHint:
              "Retry the git step so it uses the dedicated git action. If needed, finish the remaining git command in your local terminal.",
            resumeActions: ["retry", "open_terminal"],
          },
        })}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Step failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Retry the git step so it uses the dedicated git action\./i,
      ),
    ).toBeInTheDocument();
  });

  it("renders a plugin badge for dedicated git tool rows", () => {
    render(
      <ActivityRow
        row={createToolRow({
          toolName: "git_commit",
          family: "git",
          title: "Creating git commit",
          pluginLabel: "GitHub",
        })}
        expanded={true}
        onToggle={vi.fn()}
        displayMode="transcript"
      />,
    );

    expect(screen.getByText("Creating git commit")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("toggles a shell disclosure and exposes bounded runtime output", () => {
    const onToggle = vi.fn();
    render(
      <ActivityRow
        row={createToolRow({
          toolName: "shell",
          family: "shell",
          title: "pnpm test",
          status: "completed",
          details: ["$ pnpm test"],
          shell: {
            command: "pnpm test",
            output: "passed\n".repeat(800),
            sourceTruncated: true,
          },
        })}
        expanded={false}
        onToggle={onToggle}
        displayMode="transcript"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran pnpm test/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

function createCommentaryRow(
  overrides: Partial<
    Extract<ActivityFeedRowViewModel, { kind: "commentary" }>
  > = {},
): Extract<ActivityFeedRowViewModel, { kind: "commentary" }> {
  return {
    kind: "commentary",
    key: "commentary-row-1",
    phase: "commentary",
    status: "completed",
    text: "Default content",
    ...overrides,
  };
}

function createToolRow(
  overrides: Partial<Extract<ActivityFeedRowViewModel, { kind: "tool" }>> = {},
): Extract<ActivityFeedRowViewModel, { kind: "tool" }> {
  return {
    kind: "tool",
    key: "tool-row-1",
    toolName: "git_commit",
    family: "git",
    title: "Creating git commit",
    summary: "",
    status: "completed",
    defaultCollapsed: false,
    details: [],
    ...overrides,
  };
}
