import { DomainError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { resolveAuthorizedWorkspaceRepositoryContext } from "./AuthorizedWorkspaceRepositoryContext";

export async function resolveSessionRepositoryContext(input: {
  env: Env;
  userId: string;
  sessionId: string;
  workspaceId: string;
  preferredBranch?: string | null;
}) {
  const session = await withTranscriptRepository(
    input.env,
    async (repository) =>
      (await repository.listSessions(input.userId)).sessions.find(
        (candidate) => candidate.id === input.sessionId,
      ) ?? null,
  );
  if (
    !session ||
    (session.workspaceId !== null && session.workspaceId !== input.workspaceId)
  ) {
    throw new DomainError(
      "RUN_SCOPE_MISMATCH",
      "Conversation scope is unavailable.",
      409,
      false,
    );
  }
  if (session.repository === null) return null;
  const context = await resolveAuthorizedWorkspaceRepositoryContext(input);
  if (
    !context ||
    `${context.repositoryOwner}/${context.repositoryName}`.toLowerCase() !==
      session.repository.toLowerCase()
  ) {
    throw new DomainError(
      "RUN_SCOPE_MISMATCH",
      "The conversation repository is no longer available in this scope.",
      409,
      false,
    );
  }
  return context;
}
