import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../types/session";
import { AgentSidebar } from "./AgentSidebar";

function createSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: "session-1",
    name: "Draft task",
    titleSource: "generated",
    repository: "shadowbox/shadowbox",
    activeRunId: "run-1",
    runIds: ["run-1"],
    status: "running",
    mode: "build",
    pinnedAt: null,
    archivedAt: null,
    updatedAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("AgentSidebar", () => {
  it("renders awaiting approval status when the session has a pending approval", () => {
    render(
      <AgentSidebar
        sessions={[createSession()]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-1"
        approvalStatesBySessionId={{ "session-1": true }}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByTestId("task-status-needs_approval")).toHaveAttribute(
      "data-status-kind",
      "dot",
    );
  });

  it("shows the awaiting approval filter option in the sidebar menu", () => {
    render(
      <AgentSidebar
        sessions={[createSession()]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-1"
        approvalStatesBySessionId={{ "session-1": true }}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    expect(
      screen.getByRole("menuitemradio", { name: "Awaiting approval" }),
    ).toBeInTheDocument();
  });

  it("renders a spinner indicator for running sessions", () => {
    render(
      <AgentSidebar
        sessions={[createSession()]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const indicator = screen.getByTestId("task-status-running");
    expect(indicator).toHaveAttribute("data-status-kind", "spinner");
    expect(indicator.className).toContain("animate-spin");
  });

  it("shows recently completed non-active sessions as blue completed status", () => {
    render(
      <AgentSidebar
        sessions={[
          createSession({
            id: "session-2",
            status: "completed",
            updatedAt: new Date().toISOString(),
          }),
        ]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="different-session"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("task-status-completed")).toBeInTheDocument();
  });

  it("shows completed active sessions as idle status", () => {
    render(
      <AgentSidebar
        sessions={[
          createSession({
            status: "completed",
            updatedAt: new Date().toISOString(),
          }),
        ]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("task-status-idle")).toBeInTheDocument();
  });

  it("shows stale completed sessions as idle status after highlight window", () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    render(
      <AgentSidebar
        sessions={[
          createSession({
            id: "session-3",
            status: "completed",
            updatedAt: staleDate,
          }),
        ]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="different-session"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("task-status-idle")).toBeInTheDocument();
  });

  it("orders tasks by recent activity regardless of status", () => {
    render(
      <AgentSidebar
        sessions={[
          createSession({
            id: "session-old-running",
            name: "Old running",
            status: "running",
            updatedAt: "2026-04-14T12:00:00.000Z",
          }),
          createSession({
            id: "session-mid-idle",
            name: "Mid idle",
            status: "idle",
            updatedAt: "2026-04-14T12:05:00.000Z",
          }),
          createSession({
            id: "session-new-completed",
            name: "New completed",
            status: "completed",
            updatedAt: "2026-04-14T12:10:00.000Z",
          }),
        ]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-old-running"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const taskRows = screen.getAllByRole("option");
    expect(taskRows[0]).toHaveTextContent("New completed");
    expect(taskRows[1]).toHaveTextContent("Mid idle");
    expect(taskRows[2]).toHaveTextContent("Old running");
  });

  it("opens settings from the footer action", () => {
    const onOpenSettings = vi.fn();

    render(
      <AgentSidebar
        sessions={[createSession()]}
        repositories={["shadowbox/shadowbox"]}
        activeSessionId="session-1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRemove={vi.fn()}
        onAddRepository={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
