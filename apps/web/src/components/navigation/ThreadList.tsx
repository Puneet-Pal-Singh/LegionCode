import { ChevronDown, Folder, Plus, MoreHorizontal, Trash2, Edit2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useRef, useEffect } from "react";
import { cn } from "@legioncode/client-ui";

interface TaskItem {
  id: string;
  title: string;
  status: "running" | "completed" | "error" | "idle";
  isActive?: boolean;
}

interface RepositorySectionProps {
  repositoryName: string;
  tasks: TaskItem[];
  onSelectTask: (id: string) => void;
  onRemoveTask?: (id: string) => void;
  onAddTask?: () => void;
  onRemoveRepo?: () => void;
  onRenameRepo?: (newName: string) => void;
}

export function RepositorySection({
  repositoryName,
  tasks,
  onSelectTask,
  onRemoveTask,
  onAddTask,
  onRemoveRepo,
  onRenameRepo,
}: RepositorySectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(repositoryName);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
        setConfirmingRemove(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleRename = () => {
    if (newName.trim() && newName !== repositoryName) {
      onRenameRepo?.(newName);
    }
    setIsRenaming(false);
    setShowMenu(false);
  };

  const runningTasks = tasks.filter((t) => t.status === "running");
  const idleTasks = tasks.filter((t) => t.status === "idle");
  const completedTasks = tasks.filter(
    (t) => t.status === "completed" || t.status === "error",
  );
  const sortedTasks = [...runningTasks, ...idleTasks, ...completedTasks];

  return (
    <div className="mt-2 group/repo">
      {/* Repository Header */}
      <div className="flex items-center gap-1 px-1 pr-2 hover:bg-zinc-800/40 rounded-md transition-colors">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 p-1 py-2 text-sm text-zinc-300 hover:text-white flex-1 text-left truncate transition-colors"
        >
          <ChevronDown
            size={14}
            className={cn(
              "text-zinc-500 transition-transform duration-200 shrink-0",
              !isExpanded && "-rotate-90",
            )}
          />
          <Folder size={14} className="text-zinc-500 shrink-0" />
          {isRenaming ? (
            <input
              autoFocus
              className="bg-zinc-900 text-white px-1 rounded outline-none w-full text-xs py-0.5 border border-zinc-700"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") {
                  setIsRenaming(false);
                  setNewName(repositoryName);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate font-medium">{repositoryName}</span>
          )}
        </button>

        {/* Action Buttons */}
        <div className="flex items-center opacity-0 group-hover/repo:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddTask?.();
            }}
            className="p-1 text-zinc-500 hover:text-emerald-400 transition-colors"
            title="New Task"
          >
            <Plus size={14} />
          </button>
          
          <div className="relative" ref={menuRef}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
                setConfirmingRemove(false);
              }}
              className="p-1 text-zinc-500 hover:text-white transition-colors"
              title="More options"
            >
              <MoreHorizontal size={14} />
            </button>
            
            <AnimatePresence>
              {showMenu && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -10 }}
                  className="absolute right-0 mt-1 w-32 bg-[#171717] border border-zinc-800 rounded-lg shadow-xl z-50 py-1 overflow-hidden"
                >
                  {!confirmingRemove ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsRenaming(true);
                          setShowMenu(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white hover:bg-zinc-800 transition-colors"
                      >
                        <Edit2 size={12} className="text-zinc-400" />
                        Rename
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingRemove(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white hover:bg-zinc-800 transition-colors"
                      >
                        <Trash2 size={12} className="text-zinc-400" />
                        Remove
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveRepo?.();
                        setShowMenu(false);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-900/20 transition-colors"
                    >
                      Confirm Delete?
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Task Items directly under repo */}
      {isExpanded && (
        <div className="ml-4 mt-1 space-y-0.5 border-l border-zinc-800/50 pl-2">
          {sortedTasks.map((task, idx) => (
            <TaskItemComponent
              key={task.id}
              task={task}
              onSelect={() => onSelectTask(task.id)}
              onRemove={onRemoveTask ? () => onRemoveTask(task.id) : undefined}
              delay={idx * 0.03}
            />
          ))}
          {tasks.length === 0 && (
            <div className="px-3 py-1">
              <p className="text-[10px] text-zinc-600 italic">No tasks</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TaskItemComponentProps {
  task: TaskItem;
  onSelect: () => void;
  onRemove?: () => void;
  delay?: number;
}

function TaskItemComponent({
  task,
  onSelect,
  onRemove,
  delay = 0,
}: TaskItemComponentProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    if (isConfirming) {
      const timer = setTimeout(() => setIsConfirming(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isConfirming]);

  const getStatusDot = () => {
    switch (task.status) {
      case "running":
        return (
          <motion.div
            className="w-1.5 h-1.5 rounded-full bg-emerald-500"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
        );
      case "idle":
        return <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50" />;
      case "completed":
        return <div className="w-1.5 h-1.5 rounded-full bg-zinc-500" />;
      case "error":
        return <div className="w-1.5 h-1.5 rounded-full bg-red-500" />;
      default:
        return <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.2 }}
      className="relative"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-all w-full text-left",
          task.isActive
            ? "text-white bg-zinc-800/60"
            : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40",
        )}
      >
        {getStatusDot()}
        <span className="truncate flex-1">{task.title}</span>
        
        {onRemove && !isConfirming && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsConfirming(true);
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-500 hover:text-red-400 transition-all"
          >
            <Trash2 size={12} />
          </button>
        )}

        {isConfirming && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.();
            }}
            className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded border border-red-500/30 hover:bg-red-500/30 transition-colors"
          >
            CONFIRM
          </button>
        )}
      </div>
    </motion.div>
  );
}
