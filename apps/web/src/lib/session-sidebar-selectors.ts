import {
  projectThreadSidebar,
  ThreadIdSchema,
  type ProjectThreadSidebarInput,
  type ThreadSidebarThreadInput,
  type ThreadSidebarWorkspaceInput,
} from "@legioncode/sdk";
import type {
  AgentSession,
  SessionHydrationStatus,
} from "../hooks/useSessionManager";

export interface SidebarRepository {
  id: string;
  label: string;
}

export interface ProjectAgentSessionsForSidebarInput {
  sessions: readonly AgentSession[];
  repositories: readonly string[];
  activeSessionId: string | null;
  hydrationStatus: SessionHydrationStatus;
  now?: number;
}

const NO_REPOSITORY = "No repository";
const COMPLETED_HIGHLIGHT_WINDOW_MS = 5 * 60 * 1000;

export function selectSessionUnread(session: AgentSession): boolean {
  return Boolean(
    session.lastTerminalTurnId &&
    session.lastTerminalTurnId !== session.lastAcknowledgedTerminalTurnId,
  );
}

export function selectSessionActive(session: AgentSession): boolean {
  return (
    session.status === "running" || session.status === "waiting_for_approval"
  );
}

export function projectAgentSessionsForSidebar({
  sessions,
  repositories,
  activeSessionId,
  hydrationStatus,
  now = Date.now(),
}: ProjectAgentSessionsForSidebarInput) {
  const repositoryById = new Map<string, SidebarRepository>();
  for (const repository of repositories) {
    const key = repository.trim();
    if (key) repositoryById.set(key, { id: key, label: repositoryLabel(key) });
  }
  for (const session of sessions) {
    const key = session.repository?.trim();
    if (key) repositoryById.set(key, { id: key, label: repositoryLabel(key) });
  }
  if (sessions.some((session) => !session.repository?.trim())) {
    repositoryById.set(NO_REPOSITORY, {
      id: NO_REPOSITORY,
      label: NO_REPOSITORY,
    });
  }

  const workspaceByRepository = new Map<string, string>();
  const workspaces: ThreadSidebarWorkspaceInput[] = Array.from(
    repositoryById.values(),
  ).map((repository) => {
    workspaceByRepository.set(repository.id, repository.id);
    return {
      workspaceId: null,
      workspaceSelectionId: repository.id,
      label: repository.label,
      placement: "hosted",
    };
  });

  const threads: ThreadSidebarThreadInput[] = sessions.map((session) => {
    const repository = session.repository?.trim() || NO_REPOSITORY;
    return {
      selectionId: session.id,
      threadId: ThreadIdSchema.safeParse(session.id).data ?? null,
      workspaceId: null,
      workspaceSelectionId: workspaceByRepository.get(repository) ?? repository,
      title: session.name,
      updatedAt: session.updatedAt,
      pinnedAt: session.pinnedAt,
      archivedAt: session.archivedAt,
      displayStatus: displayStatus(session, activeSessionId, now),
      isUnread: selectSessionUnread(session),
    };
  });

  const state: ProjectThreadSidebarInput["state"] =
    hydrationStatus === "loading" || hydrationStatus === "idle"
      ? { status: "loading" }
      : hydrationStatus === "failed"
        ? { status: "error", message: "Could not load threads." }
        : { status: "ready" };

  return projectThreadSidebar({
    state,
    workspaces,
    threads,
    selectedSelectionId: activeSessionId,
  });
}

function displayStatus(
  session: AgentSession,
  activeSessionId: string | null,
  now: number,
): ThreadSidebarThreadInput["displayStatus"] {
  if (session.status === "running") return "running";
  if (session.status === "waiting_for_approval") return "waiting_for_approval";
  if (session.status === "paused") return "paused";
  if (session.status === "completed") {
    return hasRecentUnreadTerminal(session, activeSessionId, now)
      ? "completed"
      : "idle";
  }
  if (session.status === "failed") {
    return selectSessionUnread(session) ? "failed" : "idle";
  }
  return "idle";
}

function hasRecentUnreadTerminal(
  session: AgentSession,
  activeSessionId: string | null,
  now: number,
): boolean {
  if (
    session.id === activeSessionId ||
    !session.lastTerminalTurnId ||
    !selectSessionUnread(session)
  ) {
    return false;
  }
  const updatedAtMs = new Date(session.updatedAt).getTime();
  return (
    Number.isFinite(updatedAtMs) &&
    now - updatedAtMs <= COMPLETED_HIGHLIGHT_WINDOW_MS
  );
}

function repositoryLabel(repository: string): string {
  if (repository === NO_REPOSITORY) return repository;
  const [, name] = repository.split("/");
  return name || repository;
}
