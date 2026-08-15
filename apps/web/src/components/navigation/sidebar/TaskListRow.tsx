import {
  Archive,
  Circle,
  Clock3,
  LoaderCircle,
  Pause,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
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
  icon: LucideIcon;
  indicatorClass: string;
  kind: "icon" | "spinner";
}

const STATUS_VISUALS: Record<SidebarTaskStatus, StatusVisual> = {
  idle: {
    icon: Circle,
    indicatorClass: "text-zinc-600",
    kind: "icon",
  },
  running: {
    icon: LoaderCircle,
    indicatorClass: "animate-spin text-zinc-300",
    kind: "spinner",
  },
  paused: {
    icon: Pause,
    indicatorClass: "text-zinc-500",
    kind: "icon",
  },
  failed: {
    icon: Circle,
    indicatorClass: "fill-red-400 text-red-400",
    kind: "icon",
  },
  completed: {
    icon: Circle,
    indicatorClass: "fill-sky-400 text-sky-400",
    kind: "icon",
  },
  needs_approval: {
    icon: Clock3,
    indicatorClass: "text-zinc-400",
    kind: "icon",
  },
};

function getRelativeTime(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / 604_800)}w`;
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

function StatusIndicator({
  status,
  titlePending,
}: {
  status: SidebarTaskStatus;
  titlePending: boolean;
}) {
  if (status === "idle" && !titlePending) return null;
  const isGeneratingTitle = titlePending && status === "idle";
  const visual = STATUS_VISUALS[isGeneratingTitle ? "running" : status];
  const StatusIcon = visual.icon;
  const isNotification = status === "failed" || status === "completed";

  return (
    <span
      className="inline-flex size-4 items-center justify-center"
      aria-hidden="true"
    >
      <StatusIcon
        data-testid={
          isGeneratingTitle ? "task-title-generating" : `task-status-${status}`
        }
        data-status-kind={visual.kind}
        className={cn(
          isNotification ? "size-1.5" : "size-4",
          visual.indicatorClass,
        )}
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
        data-testid={`thread-${task.id}`}
        data-thread-id={task.id}
        data-unread={task.metrics?.unreadCount ? "true" : "false"}
        tabIndex={tabIndex}
        role="option"
        aria-selected={task.isActive}
        onFocus={onFocus}
        onClick={onSelect}
        onKeyDown={(event) => handleRowKeyDown(event, onSelect, onMoveFocus)}
        className={cn(
          "h-[34px] w-full rounded-md text-left transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500",
          task.isActive
            ? "bg-zinc-800/55 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800/35 hover:text-zinc-100",
          onRemove && isConfirmingDelete ? "pr-28" : undefined,
        )}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-1.5 pl-8 pr-2">
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              task.isActive ? "font-medium" : "font-normal",
            )}
            title={task.title}
          >
            {task.title}
          </span>
          <div
            className={cn(
              "flex shrink-0 items-center justify-end gap-1.5 text-xs transition-[margin]",
              onRemove && !isConfirmingDelete
                ? "group-hover:mr-6 group-focus-within:mr-6"
                : undefined,
            )}
          >
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
            <span
              className="w-0 overflow-hidden whitespace-nowrap text-zinc-500 opacity-0 transition-[width,opacity] group-hover:w-auto group-hover:opacity-100 group-focus-within:w-auto group-focus-within:opacity-100"
              title={relativeTime}
            >
              {relativeTime}
            </span>
            <StatusIndicator
              status={task.status}
              titlePending={Boolean(task.titlePending)}
            />
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
      ) : (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onRemove ? (
            <button
              type="button"
              aria-label={`Archive ${task.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setIsConfirmingDelete(true);
              }}
              className="grid size-5 place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              <Archive size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}
