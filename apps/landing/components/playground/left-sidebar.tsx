"use client";

import {
  ChevronRight,
  Clock,
  FolderPlus,
  Search,
  Settings,
} from "lucide-react";

interface LeftSidebarProps {
  activeTaskId: string;
  isOpen: boolean;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
}

interface TaskLink {
  id: string;
  label: string;
  timestamp: string;
}

const workspaceGroups: Array<{ label: string; tasks: TaskLink[] }> = [
  {
    label: "LegionCode/",
    tasks: [
      {
        id: "onboarding",
        label: "Add repository onboarding flow",
        timestamp: "just now",
      },
      {
        id: "execution",
        label: "Polish sandbox execution",
        timestamp: "15m ago",
      },
    ],
  },
  {
    label: "project-alpha/",
    tasks: [
      { id: "readme", label: "Sync README.md docs", timestamp: "1h ago" },
      {
        id: "verification",
        label: "Run validation gates",
        timestamp: "3h ago",
      },
    ],
  },
];

function TaskButton({
  active,
  task,
  onSelect,
}: {
  active: boolean;
  task: TaskLink;
  onSelect: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={`w-full rounded-md px-5 py-2 text-left transition-colors ${
        active
          ? "border-l-2 border-white bg-white/10 text-white"
          : "text-zinc-400 hover:bg-white/[0.03]"
      }`}
    >
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-xs font-medium">{task.label}</span>
        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
          <Clock className="h-2.5 w-2.5" /> {task.timestamp}
        </span>
      </span>
    </button>
  );
}

function WorkspaceGroup({
  activeTaskId,
  group,
  onSelect,
}: {
  activeTaskId: string;
  group: { label: string; tasks: TaskLink[] };
  onSelect: (taskId: string) => void;
}) {
  return (
    <div>
      <div className="flex select-none items-center gap-1 px-2 py-1 font-mono text-[11px] text-zinc-400">
        <ChevronRight className="h-3.5 w-3.5 rotate-90 text-zinc-650" />
        <span>{group.label}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {group.tasks.map((task) => (
          <TaskButton
            key={task.id}
            active={activeTaskId === task.id}
            task={task}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarFooter() {
  return (
    <div className="flex flex-col gap-1 border-t border-white/5 p-2">
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-zinc-500">
        <FolderPlus className="h-3.5 w-3.5" />
        <span>Add repository</span>
      </div>
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-zinc-500">
        <Settings className="h-3.5 w-3.5" />
        <span>Settings</span>
      </div>
    </div>
  );
}

export default function LeftSidebar({
  activeTaskId,
  isOpen,
  onClose,
  onSelectTask,
}: LeftSidebarProps) {
  const selectAndClose = (taskId: string) => {
    onSelectTask(taskId);
    onClose();
  };

  return (
    <div
      className={`absolute inset-y-0 left-0 z-30 flex w-56 shrink-0 flex-col justify-between border-r border-white/5 bg-[#0c0c0ced]/95 backdrop-blur-xl transition-transform duration-300 lg:static lg:flex lg:translate-x-0 lg:bg-black/25 lg:backdrop-blur-md ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="py-2.5">
        <div className="mb-3 flex items-center justify-between px-3.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          <span>Workspaces</span>
          <Settings className="h-3.5 w-3.5 opacity-60" />
        </div>
        <div className="mb-4 px-3">
          <div className="flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5 text-[11px] text-zinc-500">
            <Search className="h-3 w-3" />
            <span>Search task history...</span>
          </div>
        </div>
        <div className="space-y-4 px-1.5">
          {workspaceGroups.map((group) => (
            <WorkspaceGroup
              key={group.label}
              activeTaskId={activeTaskId}
              group={group}
              onSelect={selectAndClose}
            />
          ))}
        </div>
      </div>
      <SidebarFooter />
    </div>
  );
}
