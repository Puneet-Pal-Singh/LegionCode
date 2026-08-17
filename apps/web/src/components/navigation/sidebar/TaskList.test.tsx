import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskList } from "./TaskList";

function createTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `thr_task${String(index).padStart(3, "0")}`,
    title: `Task ${index + 1}`,
    status: "idle" as const,
    updatedAt: "2026-07-16T10:00:00.000Z",
    isActive: false,
  }));
}

describe("TaskList progressive loading", () => {
  it("starts with five tasks and reveals ten more per click", () => {
    render(
      <TaskList tasks={createTasks(16)} onSelectTask={vi.fn()} />,
    );

    expect(screen.getAllByRole("option")).toHaveLength(5);
    const showMore = screen.getByRole("button", { name: /show more/i });
    expect(showMore).toBeInTheDocument();

    fireEvent.click(showMore);
    expect(screen.getAllByRole("option")).toHaveLength(15);

    fireEvent.click(showMore);
    expect(screen.getAllByRole("option")).toHaveLength(16);
    expect(
      screen.queryByRole("button", { name: /show more/i }),
    ).not.toBeInTheDocument();
  });
});
