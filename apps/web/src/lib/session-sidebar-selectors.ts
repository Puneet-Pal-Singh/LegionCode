import type { AgentSession } from "../types/session";

export interface SessionRepositoryGroup {
  repository: string;
  repositoryLabel: string;
  sessions: AgentSession[];
}

const NO_REPOSITORY_LABEL = "No repository";

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
    const repository = session.repository?.trim() || NO_REPOSITORY_LABEL;
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
  if (repository === NO_REPOSITORY_LABEL) {
    return repository;
  }
  const [, name] = repository.split("/");
  return name || repository;
}
