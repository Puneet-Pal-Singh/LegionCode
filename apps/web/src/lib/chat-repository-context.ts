import { SessionStateService } from "../services/SessionStateService";
import type { ChatRequestBody } from "./chat-request";
import { doesSessionContextMatchRepository } from "./repository-context-match";

export function loadRepositoryContextFields(
  sessionId: string,
): Pick<
  ChatRequestBody,
  | "repositoryOwner"
  | "repositoryName"
  | "repositoryBranch"
  | "repositoryBaseUrl"
> {
  const context = SessionStateService.loadSessionGitHubContext(sessionId);
  if (!context) {
    return {};
  }

  const session = SessionStateService.loadSessions()[sessionId];
  if (
    session &&
    !doesSessionContextMatchRepository(session.repository, {
      fullName: context.fullName,
      repoName: context.repoName,
    })
  ) {
    console.warn(
      `[useChatCore] Ignoring stale repository context for session ${sessionId}. Expected ${session.repository}, received ${context.fullName}.`,
    );
    SessionStateService.clearSessionGitHubContext(sessionId);
    return {};
  }

  const owner =
    typeof context.repoOwner === "string" ? context.repoOwner.trim() : "";
  const name =
    typeof context.repoName === "string" ? context.repoName.trim() : "";
  const branch =
    typeof context.branch === "string" ? context.branch.trim() : "";
  const fullName =
    typeof context.fullName === "string" ? context.fullName.trim() : "";

  if (!owner || !name) {
    return {};
  }

  return {
    repositoryOwner: owner,
    repositoryName: name,
    repositoryBranch: branch || undefined,
    repositoryBaseUrl: fullName ? `https://github.com/${fullName}` : undefined,
  };
}
