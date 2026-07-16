import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskListRow } from "./TaskListRow";

describe("TaskListRow product identity contract", () => {
  it("exposes the server thread id and unread projection to the browser gate", () => {
    render(
      <TaskListRow
        task={{
          id: "thr_server001",
          title: "Concurrent task",
          status: "completed",
          updatedAt: "2026-07-16T10:00:00.000Z",
          isActive: false,
          metrics: { unreadCount: 1 },
        }}
        tabIndex={0}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onMoveFocus={vi.fn()}
      />,
    );

    const row = screen.getByRole("option", { name: /Concurrent task/ });
    expect(row).toHaveAttribute("data-testid", "thread-thr_server001");
    expect(row).toHaveAttribute("data-thread-id", "thr_server001");
    expect(row).toHaveAttribute("data-unread", "true");
  });
});
