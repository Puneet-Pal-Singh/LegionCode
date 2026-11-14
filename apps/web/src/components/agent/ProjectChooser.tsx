import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ButtonHTMLAttributes,
  type RefAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check, Folder, MessageSquare, Plus, Search } from "lucide-react";
import { useOutsideDismiss, useViewportPopoverPosition } from "@legioncode/client-ui";

interface ProjectChooserProps {
  currentProject?: string;
  projects: readonly string[];
  onSelect: (project: string) => void;
  onNewProject: () => void;
  onNoProject: () => void;
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>>;
}

export function ProjectChooser({
  currentProject,
  projects,
  onSelect,
  onNewProject,
  onNoProject,
  children,
}: ProjectChooserProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  const insideRefs = useMemo(() => [panelRef], []);
  const panelStyle = useViewportPopoverPosition(isOpen, triggerRef, panelRef, {
    align: "auto", placement: "auto", preferredWidth: 288,
  });
  // The shared dismissal owner also guards Escape during IME composition and
  // restores the trigger without reclaiming focus after an outside click.
  useOutsideDismiss(rootRef, isOpen, close, {
    additionalRefs: insideRefs,
    escapeFocusRef: triggerRef,
  });
  useEffect(() => {
    if (!isOpen || panelStyle.visibility !== "visible") return;
    const firstControl = searchRef.current ??
      panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (firstControl ?? panelRef.current)?.focus({ preventScroll: true });
  }, [isOpen, panelStyle.visibility]);
  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projects
      .filter((project) => project.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => left.localeCompare(right));
  }, [projects, query]);
  const currentProjectName = currentProject?.split("/").filter(Boolean).at(-1);

  const choose = (action: () => void) => {
    setQuery("");
    close();
    if (triggerRef.current?.isConnected && !triggerRef.current.disabled)
      triggerRef.current.focus({ preventScroll: true });
    // Restore before dispatch: a newly opened repository dialog owns its focus.
    action();
  };

  return (
    <div
      ref={rootRef}
      className="relative inline-flex min-w-0 max-w-full"
    >
      {cloneElement(children, {
        ref: triggerRef,
        "aria-haspopup": "dialog",
        "aria-expanded": isOpen,
        "aria-controls": isOpen ? dialogId : undefined,
        onClick: (event) => {
          children.props.onClick?.(event);
          if (event.defaultPrevented || children.props.disabled) return;
          setQuery("");
          setIsOpen((current) => !current);
        },
      })}
      {isOpen && typeof document !== "undefined" ? createPortal(
        <div
          ref={panelRef}
          id={dialogId}
          role="dialog"
          aria-label="Choose project"
          tabIndex={-1}
          className="ui-surface-popover fixed z-50 overflow-y-auto p-2"
          style={panelStyle}
        >
          {projects.length > 0 ? (
            <label className="flex h-10 items-center gap-2 border-b border-zinc-800 px-2 text-zinc-400">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            </label>
          ) : null}
          <div className="max-h-64 overflow-y-auto py-1">
            {visibleProjects.length === 0 ? (
              <p className="px-2 py-3 text-xs text-zinc-400">
                {projects.length === 0
                  ? "No projects yet. Add one to work with a repository."
                  : "No matching projects"}
              </p>
            ) : null}
            {visibleProjects.map((project) => (
              <button
                key={project}
                type="button"
                onClick={() => choose(() => onSelect(project))}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-zinc-200 hover:bg-zinc-800/70"
              >
                <Folder size={16} className="shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">
                  {project.split("/").filter(Boolean).at(-1) ?? project}
                </span>
                {project === currentProject ||
                project === currentProjectName ? (
                  <Check size={16} data-testid="project-chooser-current" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="border-t border-zinc-800 pt-1">
            <button
              type="button"
              onClick={() => choose(onNewProject)}
              className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-sm text-zinc-200 hover:bg-zinc-800/70"
            >
              <Plus size={16} /> New project
            </button>
            <button
              type="button"
              onClick={() => choose(onNoProject)}
              className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-sm text-zinc-200 hover:bg-zinc-800/70"
            >
              <MessageSquare size={16} /> Don&apos;t work in a project
              {!currentProject ? <Check size={16} className="ml-auto" /> : null}
            </button>
          </div>
        </div>, document.body,
      ) : null}
    </div>
  );
}
