import {
  Check,
  FolderPlus,
  MoreHorizontal,
  Pin,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession } from "../../hooks/useSessionManager";
import {
  groupSessionsByRepository,
  selectPinnedSessions,
  selectSessionUnread,
} from "../../lib/session-sidebar-selectors";
import {
  SidebarShell,
  TaskList,
  WorkspaceSection,
  type SidebarTaskItem,
  type SidebarTaskStatus,
} from "../navigation/sidebar";
import {
  SidebarAccountMenu,
  type SidebarAccountUser,
} from "./SidebarAccountMenu";

interface AgentSidebarProps {
  sessions: AgentSession[];
  repositories: string[];
  activeSessionId: string | null;
  approvalStatesBySessionId?: Record<string, boolean>;
  onSelect: (id: string) => void;
  onCreate: (repo?: string) => void;
  onRemove: (id: string) => void;
  onRemoveRepository?: (repo: string) => void;
  onRenameRepository?: (oldName: string, newName: string) => void;
  onClose?: () => void;
  onAddRepository: () => void;
  onOpenSettings: () => void;
  accountUser?: SidebarAccountUser | null;
  onLogout?: () => Promise<void>;
  width?: number;
}

type TaskStatusFilter =
  | "all"
  | "needs_approval"
  | "running"
  | "paused"
  | "idle"
  | "completed"
  | "failed";

const FILTER_OPTIONS: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: "all", label: "All tasks" },
  { value: "needs_approval", label: "Awaiting approval" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
  { value: "idle", label: "Idle" },
];

const COMPLETED_HIGHLIGHT_WINDOW_MS = 5 * 60 * 1000;

function buildTaskMetrics(
  session: AgentSession,
  hasPendingApproval: boolean,
): SidebarTaskItem["metrics"] {
  const metrics: NonNullable<SidebarTaskItem["metrics"]> = {};
  if (hasPendingApproval) {
    metrics.label = "Awaiting approval";
  }
  if (selectSessionUnread(session)) {
    metrics.unreadCount = 1;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function shouldHighlightCompleted(
  session: AgentSession,
  activeSessionId: string | null,
): boolean {
  if (session.id === activeSessionId) {
    return false;
  }
  const updatedAtMs = new Date(session.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }
  return Date.now() - updatedAtMs <= COMPLETED_HIGHLIGHT_WINDOW_MS;
}

function mapSessionStatus(
  session: AgentSession,
  activeSessionId: string | null,
): SidebarTaskStatus {
  const status = session.status;
  if (status === "running") return "running";
  if (status === "waiting_for_approval") return "needs_approval";
  if (status === "paused") return "paused";
  if (status === "completed") {
    return shouldHighlightCompleted(session, activeSessionId)
      ? "completed"
      : "idle";
  }
  if (status === "failed") return "failed";
  return "idle";
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function getRepositoryLabel(repository: string): string {
  if (repository === "No repository") {
    return repository;
  }
  const [, name] = repository.split("/");
  return name || repository;
}

function matchesSearch(value: string, query: string): boolean {
  return normalizeSearch(value).includes(query);
}

function filterTasks(
  tasks: SidebarTaskItem[],
  query: string,
  statusFilter: TaskStatusFilter,
): SidebarTaskItem[] {
  return tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (!query) return true;
    return matchesSearch(task.title, query);
  });
}

export function AgentSidebar({
  sessions,
  repositories,
  activeSessionId,
  approvalStatesBySessionId = {},
  onSelect,
  onCreate,
  onRemove,
  onRemoveRepository,
  onRenameRepository,
  onClose,
  onAddRepository,
  onOpenSettings,
  accountUser,
  onLogout,
  width = 280,
}: AgentSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("all");
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = normalizeSearch(searchQuery);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (
        filterMenuRef.current &&
        !filterMenuRef.current.contains(event.target as Node)
      ) {
        setIsFilterMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isSearchOpen) searchInputRef.current?.focus();
  }, [isSearchOpen]);

  const repositorySource = useMemo(() => {
    const combined = new Set<string>();
    repositories.forEach((repository) => combined.add(repository));
    sessions.forEach((session) => {
      if (session.archivedAt !== null || session.pinnedAt !== null) {
        return;
      }
      const normalizedRepository = session.repository?.trim() ?? "";
      if (normalizedRepository.length > 0) {
        combined.add(normalizedRepository);
      } else {
        combined.add("No repository");
      }
    });
    return Array.from(combined);
  }, [repositories, sessions]);

  const repositorySections = useMemo(() => {
    const groupedSessions = groupSessionsByRepository(sessions);
    const sectionsByRepository = new Map(
      groupedSessions.map((section) => [section.repository, section.sessions]),
    );

    return repositorySource
      .map((repository) => {
        const sectionSessions = sectionsByRepository.get(repository) ?? [];
        const allTasks = sectionSessions.map<SidebarTaskItem>((session) => ({
          id: session.id,
          title: session.name,
          status: approvalStatesBySessionId[session.id]
            ? "needs_approval"
            : mapSessionStatus(session, activeSessionId),
          updatedAt: session.updatedAt,
          isActive: session.id === activeSessionId,
          context: getRepositoryLabel(repository),
          metrics: buildTaskMetrics(
            session,
            Boolean(approvalStatesBySessionId[session.id]),
          ),
        }));

        const statusFilteredTasks = filterTasks(allTasks, "", statusFilter);
        const filteredTasks = filterTasks(
          allTasks,
          normalizedQuery,
          statusFilter,
        );
        const repoMatches = normalizedQuery
          ? matchesSearch(repository, normalizedQuery) ||
            matchesSearch(getRepositoryLabel(repository), normalizedQuery)
          : true;
        const tasksToRender = repoMatches ? statusFilteredTasks : filteredTasks;

        return {
          repository,
          repositoryLabel: getRepositoryLabel(repository),
          tasks: tasksToRender,
          shouldRender: repoMatches || filteredTasks.length > 0,
        };
      })
      .filter((section) => section.shouldRender);
  }, [
    activeSessionId,
    approvalStatesBySessionId,
    normalizedQuery,
    repositorySource,
    sessions,
    statusFilter,
  ]);

  const pinnedTasks = useMemo(() => {
    return filterTasks(
      selectPinnedSessions(sessions).map<SidebarTaskItem>((session) => ({
        id: session.id,
        title: session.name,
        status: approvalStatesBySessionId[session.id]
          ? "needs_approval"
          : mapSessionStatus(session, activeSessionId),
        updatedAt: session.pinnedAt ?? session.updatedAt,
        isActive: session.id === activeSessionId,
        metrics: buildTaskMetrics(
          session,
          Boolean(approvalStatesBySessionId[session.id]),
        ),
      })),
      normalizedQuery,
      statusFilter,
    );
  }, [
    activeSessionId,
    approvalStatesBySessionId,
    normalizedQuery,
    sessions,
    statusFilter,
  ]);

  const utility = (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => onCreate()}
        className="grid h-9 w-full grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800/65 hover:text-white"
      >
        <span className="flex size-8 items-center justify-center">
          <SquarePen size={16} aria-hidden="true" />
        </span>
        <span>New task</span>
      </button>

      {isSearchOpen ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
            size={15}
          />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchQuery("");
                setIsSearchOpen(false);
              }
            }}
            placeholder="Search tasks and projects"
            className="ui-input h-9 w-full rounded-lg pl-9 pr-9 text-sm text-zinc-300"
            aria-label="Search tasks"
          />
          <button
            type="button"
            onClick={() => {
              setSearchQuery("");
              setIsSearchOpen(false);
            }}
            aria-label="Close search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsSearchOpen(true)}
          className="grid h-9 w-full grid-cols-[2rem_minmax(0,1fr)] items-center rounded-lg text-left text-sm font-medium text-zinc-100 transition hover:bg-zinc-800/55 hover:text-white"
        >
          <span className="flex size-8 items-center justify-center">
            <Search size={16} aria-hidden="true" />
          </span>
          <span>Search</span>
        </button>
      )}
    </div>
  );

  const projectsHeader = (
    <div className="group/projects flex h-10 items-center justify-between px-2">
      <span className="text-sm font-medium text-zinc-500">Projects</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Add project"
          onClick={onAddRepository}
          className="rounded-md p-1.5 text-zinc-500 opacity-0 transition-all hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:opacity-100 group-hover/projects:opacity-100"
          title="Add project"
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
        <div className="relative" ref={filterMenuRef}>
          <button
            type="button"
            aria-label="Filter tasks"
            onClick={() => setIsFilterMenuOpen((value) => !value)}
            className="rounded-md p-1.5 text-zinc-500 opacity-0 transition hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:opacity-100 group-hover/projects:opacity-100"
            title="Filter tasks"
            aria-haspopup="menu"
            aria-expanded={isFilterMenuOpen}
          >
            <MoreHorizontal
              size={14}
              aria-hidden="true"
              className={statusFilter !== "all" ? "text-emerald-300" : undefined}
            />
          </button>

          {isFilterMenuOpen ? (
            <div
              role="menu"
              className="ui-surface-popover absolute right-0 top-8 z-30 w-48 p-2"
            >
              <div className="px-2 pb-1 pt-1 text-sm text-zinc-500">
                Show tasks
              </div>
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setStatusFilter(option.value);
                    setIsFilterMenuOpen(false);
                  }}
                  className="flex min-h-9 w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  role="menuitemradio"
                  aria-checked={statusFilter === option.value}
                >
                  <span>{option.label}</span>
                  {statusFilter === option.value ? (
                    <Check size={14} className="text-zinc-300" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  const footer = (
    <div>
      <SidebarAccountMenu
        user={accountUser}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
      />
    </div>
  );

  return (
    <SidebarShell
      width={width}
      header={
        <div className="truncate text-base font-semibold tracking-tight">
          <span className="text-zinc-100">Legion</span>
          <span className="text-zinc-500">Code</span>
        </div>
      }
      utility={utility}
      footer={footer}
      onClose={onClose}
    >
      <div className="space-y-3">
        {projectsHeader}
        {pinnedTasks.length > 0 ? (
          <section className="space-y-1">
            <div className="grid h-9 grid-cols-[2rem_minmax(0,1fr)] items-center">
              <span className="flex size-8 items-center justify-center text-zinc-500">
                <Pin size={14} aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-zinc-100">
                Pinned
              </span>
            </div>
            <div>
              <TaskList
                tasks={pinnedTasks}
                onSelectTask={onSelect}
                onRemoveTask={onRemove}
              />
            </div>
          </section>
        ) : null}

        {repositorySections.map((section) => (
          <WorkspaceSection
            key={section.repository}
            workspaceName={section.repositoryLabel}
            tasks={section.tasks}
            onSelectTask={onSelect}
            onAddTask={() => onCreate(section.repository)}
            onRemoveTask={onRemove}
            onRemoveWorkspace={() => onRemoveRepository?.(section.repository)}
            onRenameWorkspace={(newName) =>
              onRenameRepository?.(section.repository, newName)
            }
          />
        ))}

        {repositorySections.length === 0 ? (
          <p className="px-2 py-3 text-xs italic text-zinc-600">
            No matching tasks or projects
          </p>
        ) : null}
      </div>
    </SidebarShell>
  );
}
