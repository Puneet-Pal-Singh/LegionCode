import type { AgentSession } from "../types/session";

export interface SessionRepositoryGroup {
  repository: string;
  repositoryLabel: string;
  sessions: AgentSession[];
}

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

export function selectRecentSessions(sessions: AgentSession[]): AgentSession[] {
  return selectVisibleSessions(sessions)
    .filter(
      (session) => session.repository === null && session.pinnedAt === null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function selectVisibleSessions(
  sessions: AgentSession[],
): AgentSession[] {
  return sessions.filter((session) => session.archivedAt === null);
}

export function selectPinnedSessions(sessions: AgentSession[]): AgentSession[] {
  return selectVisibleSessions(sessions)
    .filter((session) => session.pinnedAt !== null)
    .sort((left, right) =>
      (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? ""),
    );
}

export function groupSessionsByRepository(
  sessions: AgentSession[],
): SessionRepositoryGroup[] {
  const groups = new Map<string, AgentSession[]>();
  for (const session of selectVisibleSessions(sessions)) {
    if (session.pinnedAt !== null) {
      continue;
    }
    const repository = session.repository?.trim();
    if (!repository) continue;
    groups.set(repository, [...(groups.get(repository) ?? []), session]);
  }

  return Array.from(groups.entries())
    .map(([repository, groupSessions]) => ({
      repository,
      repositoryLabel: getRepositoryLabel(repository),
      sessions: groupSessions.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    }))
    .sort((left, right) =>
      left.repositoryLabel.localeCompare(right.repositoryLabel),
    );
}

function getRepositoryLabel(repository: string): string {
  const [, name] = repository.split("/");
  return name || repository;
}
