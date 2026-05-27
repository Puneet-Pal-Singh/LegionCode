import { RotateCcw } from "lucide-react";
import { useState } from "react";
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
  const { sessions, isLoading, error, removeSession } =
    useArchivedSessions(isActive);
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(
    null,
  );

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

  if (error) {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-zinc-500">No archived chats</p>;
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => (
        <div
          key={session.id}
          className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/50 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">
              {session.name}
            </p>
            <p className="mt-1 truncate text-xs text-zinc-500">
              {session.repository ?? "No repository"} -{" "}
              {formatArchivedDate(session)}
            </p>
          </div>
          <button
            type="button"
            disabled={restoringSessionId === session.id}
            onClick={() => void restoreSession(session)}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw size={14} />
            Unarchive
          </button>
        </div>
      ))}
    </div>
  );
}

function formatArchivedDate(session: AgentSession): string {
  const timestamp = session.archivedAt ?? session.updatedAt;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : date.toLocaleDateString();
}
