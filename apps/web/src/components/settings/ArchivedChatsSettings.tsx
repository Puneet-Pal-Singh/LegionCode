import { Folder, RotateCcw, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useArchivedSessions } from "../../hooks/useArchivedSessions";
import type { AgentSession } from "../../types/session";

interface ArchivedChatsSettingsProps {
  isActive: boolean;
  onUnarchiveSession: (sessionId: string) => Promise<void>;
}

export function ArchivedChatsSettings({
  isActive,
  onUnarchiveSession,
}: ArchivedChatsSettingsProps): React.ReactElement {
  const {
    sessions,
    isLoading,
    error,
    removeSession,
    deleteSession,
    deleteAllSessions,
  } = useArchivedSessions(isActive);
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const projects = useMemo(
    () =>
      [...new Set(sessions.map((session) => getProjectName(session)))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [sessions],
  );
  const groupedSessions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const groups = new Map<string, AgentSession[]>();

    for (const session of sessions) {
      const project = getProjectName(session);
      if (projectFilter !== "all" && project !== projectFilter) continue;
      if (
        normalizedQuery &&
        !session.name.toLowerCase().includes(normalizedQuery) &&
        !project.toLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      groups.set(project, [...(groups.get(project) ?? []), session]);
    }

    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [projectFilter, searchQuery, sessions]);

  const restoreSession = async (session: AgentSession): Promise<void> => {
    setRestoringSessionId(session.id);
    try {
      await onUnarchiveSession(session.id);
      removeSession(session.id);
    } finally {
      setRestoringSessionId(null);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-zinc-500">Loading archived chats...</p>;
  }

  return (
    <div className="space-y-7">
      <div className="grid items-center gap-3 md:grid-cols-[minmax(16rem,1fr)_220px_auto]">
        <label className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search archived chats"
            className="ui-input h-10 w-full pl-10 pr-3 text-sm"
          />
        </label>
        <label className="relative">
          <Folder
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <select
            aria-label="Filter archived chats by project"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.currentTarget.value)}
            className="ui-input h-10 w-full appearance-none pl-10 pr-3 text-sm"
          >
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </label>
        {sessions.length > 0 ? (
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              if (!confirmingDeleteAll) {
                setConfirmingDeleteAll(true);
                return;
              }
              setDeleting(true);
              void deleteAllSessions()
                .catch(() => undefined)
                .finally(() => {
                  setDeleting(false);
                  setConfirmingDeleteAll(false);
                });
            }}
            className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={14} />
            {confirmingDeleteAll ? "Confirm all" : "Delete all"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {groupedSessions.length === 0 ? (
        <div className="py-12 text-center text-sm text-zinc-500">
          {sessions.length === 0
            ? "No archived chats"
            : "No archived chats match your filters"}
        </div>
      ) : null}

      {groupedSessions.map(([project, projectSessions]) => (
        <section key={project} className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Folder size={15} className="text-zinc-500" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-zinc-200">{project}</h3>
            <span className="text-xs text-zinc-600">
              {projectSessions.length}{" "}
              {projectSessions.length === 1 ? "chat" : "chats"}
            </span>
          </div>
          <div className="ui-surface-section overflow-hidden px-5">
            {projectSessions.map((session, index) => (
              <div
                key={session.id}
                className={`flex min-h-20 items-center justify-between gap-4 py-4 ${
                  index > 0 ? "border-t border-zinc-800/70" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {session.name}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {formatArchivedDate(session)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Delete ${session.name}`}
                    disabled={deleting}
                    onClick={() => {
                      setDeleting(true);
                      void deleteSession(session.id)
                        .catch(() => undefined)
                        .finally(() => setDeleting(false));
                    }}
                    className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 size={15} />
                  </button>
                  <button
                    type="button"
                    disabled={restoringSessionId === session.id || deleting}
                    onClick={() => void restoreSession(session)}
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-800/70 px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw size={14} />
                    Unarchive
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function getProjectName(session: AgentSession): string {
  const repository = session.repository?.trim();
  if (!repository) return "No project";
  const segments = repository.split("/").filter(Boolean);
  return segments.at(-1) ?? repository;
}

function formatArchivedDate(session: AgentSession): string {
  const timestamp = session.archivedAt ?? session.updatedAt;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : date.toLocaleDateString();
}
