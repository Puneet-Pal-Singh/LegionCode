import { Archive } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { formatTimeAgo } from "../../../lib/timeFormat";
import { cn } from "../../../lib/utils";
import type { SidebarTaskItem, SidebarTaskStatus } from "./types";

interface TaskListRowProps {
  task: SidebarTaskItem;
  tabIndex: number;
  onFocus: () => void;
  onSelect: () => void;
  onRemove?: () => void;
  onMoveFocus: (delta: number) => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}

interface StatusVisual {
  indicatorClass: string;
  kind: "dot" | "spinner" | "ring";
}

const STATUS_VISUALS: Record<SidebarTaskStatus, StatusVisual> = {
  idle: {
    indicatorClass: "h-2.5 w-2.5 rounded-full bg-zinc-500/75",
    kind: "dot",
  },
  running: {
    indicatorClass:
      "h-3.5 w-3.5 rounded-full border-2 border-zinc-100/90 border-t-transparent animate-spin",
    kind: "spinner",
  },
  paused: {
    indicatorClass: "h-2.5 w-2.5 rounded-full bg-amber-300",
    kind: "dot",
  },
  failed: {
    indicatorClass: "h-2.5 w-2.5 rounded-full bg-red-400",
    kind: "dot",
  },
  completed: {
    indicatorClass: "h-2.5 w-2.5 rounded-full bg-sky-300",
    kind: "dot",
  },
  needs_approval: {
    indicatorClass: "h-2.5 w-2.5 rounded-full bg-amber-300",
    kind: "dot",
  },
};

function getRelativeTime(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? "--" : formatTimeAgo(date);
}

function getMetricsLabel(task: SidebarTaskItem): string | null {
  if (task.metrics?.label) return task.metrics.label;
  if (typeof task.metrics?.unreadCount === "number") {
    return `${task.metrics.unreadCount}`;
  }

  if (
    typeof task.metrics?.added === "number" ||
    typeof task.metrics?.removed === "number"
  ) {
    const added = task.metrics?.added ?? 0;
    const removed = task.metrics?.removed ?? 0;
    return `+${added} -${removed}`;
  }

  return null;
}

function handleRowKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  onSelect: () => void,
  onMoveFocus: (delta: number) => void,
): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    onMoveFocus(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    onMoveFocus(-1);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
}

function StatusDot({ status }: { status: SidebarTaskStatus }) {
  const visual = STATUS_VISUALS[status];

  return (
    <span
      className="inline-flex h-3.5 w-3.5 items-center justify-center"
      aria-hidden="true"
    >
      <span
        data-testid={`task-status-${status}`}
        data-status-kind={visual.kind}
        className={visual.indicatorClass}
      />
    </span>
  );
}

export function TaskListRow({
  task,
  tabIndex,
  onFocus,
  onSelect,
  onRemove,
  onMoveFocus,
  buttonRef,
}: TaskListRowProps) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const metricLabel = getMetricsLabel(task);
  const relativeTime = getRelativeTime(task.updatedAt);

  useEffect(() => {
    if (!isConfirmingDelete) return;

    const timer = window.setTimeout(() => {
      setIsConfirmingDelete(false);
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [isConfirmingDelete]);

  return (
    <li className="group relative">
      <button
        type="button"
        ref={buttonRef}
        tabIndex={tabIndex}
        role="option"
        aria-selected={task.isActive}
        onFocus={onFocus}
        onClick={onSelect}
        onKeyDown={(event) => handleRowKeyDown(event, onSelect, onMoveFocus)}
        className={cn(
          "h-10 w-full rounded-xl px-2.5 text-left transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500",
          task.isActive
            ? "bg-zinc-800/70 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800/45 hover:text-zinc-100",
          onRemove && (isConfirmingDelete ? "pr-28" : "pr-8"),
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusDot status={task.status} />
            <span
              className={cn(
                "truncate text-sm",
                task.isActive ? "font-semibold" : "font-medium",
              )}
              title={task.title}
            >
              {task.title}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {metricLabel ? (
              <span
                className={cn(
                  "font-medium",
                  task.status === "failed"
                    ? "text-red-300"
                    : task.status === "running"
                      ? "text-emerald-300"
                      : task.status === "needs_approval"
                        ? "text-amber-300"
                        : "text-zinc-400",
                )}
              >
                {metricLabel}
              </span>
            ) : null}
            <span className="text-zinc-500" title={relativeTime}>
              {relativeTime}
            </span>
          </div>
        </div>
      </button>

      {onRemove && isConfirmingDelete ? (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <button
            type="button"
            aria-label={`Cancel archive for ${task.title}`}
            onClick={(event) => {
              event.stopPropagation();
              setIsConfirmingDelete(false);
            }}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label={`Confirm archive for ${task.title}`}
            onClick={(event) => {
              event.stopPropagation();
              setIsConfirmingDelete(false);
              onRemove();
            }}
            className="rounded border border-red-700/70 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-900/40"
          >
            Confirm
          </button>
        </div>
      ) : onRemove ? (
        <button
          type="button"
          aria-label={`Archive ${task.title}`}
          onClick={(event) => {
            event.stopPropagation();
            setIsConfirmingDelete(true);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 hover:bg-zinc-800 hover:text-red-300"
        >
          <Archive size={12} aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}
