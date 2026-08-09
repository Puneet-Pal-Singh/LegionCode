import { AnimatePresence, motion } from "framer-motion";
import {
  Edit2,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TaskList } from "./TaskList";
import type { SidebarTaskItem } from "./types";

interface WorkspaceSectionProps {
  workspaceName: string;
  tasks: SidebarTaskItem[];
  onSelectTask: (taskId: string) => void;
  onAddTask?: () => void;
  onRemoveTask?: (taskId: string) => void;
  onRenameWorkspace?: (newName: string) => void;
  onRemoveWorkspace?: () => void;
  initiallyExpanded?: boolean;
}

function byRecentActivity(a: SidebarTaskItem, b: SidebarTaskItem): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sortTasks(tasks: SidebarTaskItem[]): SidebarTaskItem[] {
  return [...tasks].sort(byRecentActivity);
}

export function WorkspaceSection({
  workspaceName,
  tasks,
  onSelectTask,
  onAddTask,
  onRemoveTask,
  onRenameWorkspace,
  onRemoveWorkspace,
  initiallyExpanded = true,
}: WorkspaceSectionProps) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isConfirmingWorkspaceRemove, setIsConfirmingWorkspaceRemove] =
    useState(false);
  const [newName, setNewName] = useState(workspaceName);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNewName(workspaceName);
  }, [workspaceName]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
        setIsConfirmingWorkspaceRemove(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!isConfirmingWorkspaceRemove) return;

    const timer = window.setTimeout(() => {
      setIsConfirmingWorkspaceRemove(false);
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [isConfirmingWorkspaceRemove]);

  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);
  const FolderIcon = isExpanded ? FolderOpen : Folder;

  const confirmRename = () => {
    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName === workspaceName) {
      setNewName(workspaceName);
      setIsRenaming(false);
      return;
    }

    onRenameWorkspace?.(trimmedName);
    setIsRenaming(false);
    setShowMenu(false);
  };

  return (
    <section className="space-y-1.5">
      <div className="group/project grid h-10 grid-cols-[2rem_minmax(0,1fr)_auto] items-center rounded-xl transition hover:bg-zinc-800/35">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          className="flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-200"
          aria-expanded={isExpanded}
          aria-label={`Toggle ${workspaceName}`}
        >
          <FolderIcon size={16} aria-hidden="true" className="shrink-0" />
        </button>
        {!isRenaming ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
            {workspaceName}
          </span>
        ) : (
          <input
            autoFocus
            value={newName}
            onBlur={confirmRename}
            onChange={(event) => setNewName(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirmRename();
              if (event.key === "Escape") {
                event.preventDefault();
                setNewName(workspaceName);
                setIsRenaming(false);
              }
            }}
            className="h-7 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none"
          />
        )}

        <div className="relative flex items-center" ref={menuRef}>
          {onAddTask ? (
            <button
              type="button"
              aria-label={`New task in ${workspaceName}`}
              onClick={(event) => {
                event.stopPropagation();
                onAddTask();
              }}
              className="rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover/project:opacity-100"
              title={`New task in ${workspaceName}`}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          ) : null}

          <button
            type="button"
            aria-label={`Workspace actions for ${workspaceName}`}
            onClick={(event) => {
              event.stopPropagation();
              setShowMenu((value) => {
                const next = !value;
                if (!next) {
                  setIsConfirmingWorkspaceRemove(false);
                }
                return next;
              });
            }}
            className="rounded p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/70 hover:text-zinc-200 focus-visible:opacity-100 group-hover/project:opacity-100"
            title={`Actions for ${workspaceName}`}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>

          <AnimatePresence>
            {showMenu ? (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                className="absolute right-0 top-7 z-20 w-36 rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl"
              >
                {onRenameWorkspace ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsRenaming(true);
                      setIsConfirmingWorkspaceRemove(false);
                      setShowMenu(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-900"
                  >
                    <Edit2 size={12} className="text-zinc-500" />
                    Rename
                  </button>
                ) : null}

                {onRemoveWorkspace ? (
                  isConfirmingWorkspaceRemove ? (
                    <div className="px-2.5 py-1.5">
                      <div className="mb-1.5 text-[10px] font-medium text-zinc-500">
                        Confirm remove?
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setIsConfirmingWorkspaceRemove(false)}
                          className="flex-1 rounded border border-zinc-700 px-1.5 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onRemoveWorkspace();
                            setIsConfirmingWorkspaceRemove(false);
                            setShowMenu(false);
                          }}
                          className="flex-1 rounded border border-red-700/70 bg-red-950/40 px-1.5 py-1 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-900/40"
                        >
                          Confirm
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setIsConfirmingWorkspaceRemove(true);
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-950/40"
                    >
                      <Trash2 size={12} className="text-red-300" />
                      Remove
                    </button>
                  )
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-1 overflow-hidden"
          >
            <TaskList
              tasks={sortedTasks}
              onSelectTask={onSelectTask}
              onRemoveTask={onRemoveTask}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
