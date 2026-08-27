import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { TaskListRow } from "./TaskListRow";
import type { SidebarTaskItem } from "./types";

interface TaskListProps {
  tasks: SidebarTaskItem[];
  onSelectTask: (taskId: string) => void;
  onRemoveTask?: (taskId: string) => void;
  emptyLabel?: string;
}

const INITIAL_VISIBLE_ROWS = 5;
const LOAD_MORE_ROWS = 10;

function getInitialFocusIndex(tasks: SidebarTaskItem[]): number {
  if (tasks.length === 0) return -1;
  const activeIndex = tasks.findIndex((task) => task.isActive);
  return activeIndex >= 0 ? activeIndex : 0;
}

function clampIndex(index: number, listLength: number): number {
  if (listLength === 0) return -1;
  if (index < 0) return 0;
  if (index >= listLength) return listLength - 1;
  return index;
}

export function TaskList({
  tasks,
  onSelectTask,
  onRemoveTask,
  emptyLabel = "No tasks",
}: TaskListProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS);
  const [focusedIndex, setFocusedIndex] = useState(() => getInitialFocusIndex(tasks));
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const visibleTasks = useMemo(() => {
    if (tasks.length <= visibleCount) {
      return tasks;
    }

    const activeIndex = tasks.findIndex((task) => task.isActive);
    if (activeIndex === -1 || activeIndex < visibleCount) {
      return tasks.slice(0, visibleCount);
    }

    const activeTask = tasks[activeIndex];
    if (!activeTask) {
      return tasks.slice(0, visibleCount);
    }

    return [...tasks.slice(0, visibleCount - 1), activeTask];
  }, [tasks, visibleCount]);

  const effectiveFocusedIndex = useMemo(() => {
    const defaultFocus = getInitialFocusIndex(visibleTasks);
    if (defaultFocus === -1) return -1;
    if (focusedIndex === -1) return defaultFocus;
    return clampIndex(focusedIndex, visibleTasks.length);
  }, [focusedIndex, visibleTasks]);

  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, visibleTasks.length);
  }, [visibleTasks.length]);

  const moveFocus = useCallback(
    (currentIndex: number, delta: number) => {
      const nextIndex = clampIndex(currentIndex + delta, visibleTasks.length);
      if (nextIndex === -1) return;

      setFocusedIndex(nextIndex);
      rowRefs.current[nextIndex]?.focus();
    },
    [visibleTasks.length],
  );

  if (tasks.length === 0) {
    return <p className="px-2.5 py-2 text-xs italic text-zinc-600">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-0.5">
      <ul role="listbox" aria-label="Tasks" className="space-y-0.5">
        {visibleTasks.map((task, index) => (
          <TaskListRow
            key={task.id}
            task={task}
            tabIndex={index === effectiveFocusedIndex ? 0 : -1}
            onFocus={() => setFocusedIndex(index)}
            onSelect={() => onSelectTask(task.id)}
            onRemove={onRemoveTask ? () => onRemoveTask(task.id) : undefined}
            onMoveFocus={(delta) => moveFocus(index, delta)}
            buttonRef={(element) => {
              rowRefs.current[index] = element;
            }}
          />
        ))}
      </ul>

      {tasks.length > visibleCount ? (
        <button
          type="button"
          onClick={() =>
            setVisibleCount((count) =>
              Math.min(count + LOAD_MORE_ROWS, tasks.length),
            )
          }
          className="flex h-7 items-center gap-1.5 pl-8 pr-2 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <span>Show more</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
