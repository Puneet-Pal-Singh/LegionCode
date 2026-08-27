import { useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Folder, Plus, Search, X } from "lucide-react";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";

interface ProjectChooserProps {
  currentProject?: string;
  projects: readonly string[];
  onSelect: (project: string) => void;
  onNewProject: () => void;
  onNoProject: () => void;
  children: ReactNode;
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
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(rootRef, isOpen, () => setIsOpen(false));
  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projects
      .filter((project) =>
        project.toLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => left.localeCompare(right));
  }, [projects, query]);
  const currentProjectName = currentProject
    ?.split("/")
    .filter(Boolean)
    .at(-1);

  const choose = (action: () => void) => {
    action();
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <div onClick={() => setIsOpen((current) => !current)}>{children}</div>
      {isOpen ? (
        <div
          role="dialog"
          aria-label="Choose project"
          className="ui-surface-popover absolute left-1/2 top-full z-50 mt-2 w-80 -translate-x-1/2 overflow-hidden p-2"
        >
          <label className="flex h-10 items-center gap-2 border-b border-zinc-800 px-2 text-zinc-400">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </label>
          <div className="max-h-64 overflow-y-auto py-1">
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
                {project === currentProject || project === currentProjectName ? (
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
              <X size={16} /> Don&apos;t work in a project
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
