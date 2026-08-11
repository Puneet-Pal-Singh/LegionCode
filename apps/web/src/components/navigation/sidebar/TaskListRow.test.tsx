import { fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps notification status compact and exposes review and archive actions", () => {
    const onOpenReview = vi.fn();
    const onRemove = vi.fn();

    render(
      <TaskListRow
        task={{
          id: "thr_actions001",
          title: "Review sidebar actions",
          status: "failed",
          updatedAt: "2026-07-16T10:00:00.000Z",
          isActive: false,
        }}
        tabIndex={0}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onOpenReview={onOpenReview}
        onRemove={onRemove}
        onMoveFocus={vi.fn()}
      />,
    );

    expect(screen.getByTestId("task-status-failed")).toHaveClass("size-1.5");

    fireEvent.click(screen.getByRole("button", { name: "Open review for Review sidebar actions" }));
    expect(onOpenReview).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Archive Review sidebar actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive for Review sidebar actions" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
