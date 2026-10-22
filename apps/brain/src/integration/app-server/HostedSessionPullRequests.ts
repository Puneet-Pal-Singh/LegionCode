import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import { GitHubAPIError, type GitHubAPIClient, type PullRequest } from "@legioncode/github-bridge";
import { readConversationHistory } from "@legioncode/sdk";
import {
  HostedSessionPullRequestsResponseSchema,
  type ConversationHistoryMessage,
  type HostedSessionPullRequest,
  type HostedSessionPullRequestsResponse,
} from "@repo/platform-protocol";
import { getGitHubClient } from "../../services/AuthService";
import type { Env } from "../../types/ai";
import { ConversationHistoryNotFoundError, readHostedConversationHistory } from "./HostedConversationHistory";

const HISTORY_PAGE_SIZE = 100;
const GITHUB_READ_CONCURRENCY = 2;
// Match the canonical PR path and allow normal URL suffixes (trailing slash,
// query, fragment, or PR subpage). The left boundary prevents treating a
// github.com substring inside another URL or identifier as a chat link.
const PULL_REQUEST_URL = /(?<![A-Za-z0-9_@./-])https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?![A-Za-z0-9_-])/gi;

interface PullRequestCandidate {
  owner: string;
  repository: string;
  number: number;
}

/** Derives PR links from an owned saved chat and verifies each link with GitHub. */
export function composeHostedSessionPullRequests(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedSessionPullRequestService"]> {
  return {
    read: async (sessionId) => {
      try {
        return await readHostedSessionPullRequests(request, env, userId, sessionId);
      } catch (error) {
        if (error instanceof AppServerOperationError) throw error;
        if (error instanceof ConversationHistoryNotFoundError) {
          throw new AppServerOperationError(404, "not_found", "Conversation not found");
        }
        return unavailable(sessionId);
      }
    },
  };
}

async function readHostedSessionPullRequests(
  request: Request,
  env: Env,
  userId: string,
  sessionId: string,
): Promise<HostedSessionPullRequestsResponse> {
  const firstPage = await readHostedConversationHistory(env, userId, {
    session: sessionId,
    limit: HISTORY_PAGE_SIZE,
  });
  const history = await readConversationHistory<ConversationHistoryMessage>(
    (cursor, snapshot) => cursor === null
      ? Promise.resolve(firstPage)
      : readHostedConversationHistory(env, userId, {
          session: sessionId,
          cursor: cursor ?? undefined,
          snapshot: snapshot ?? undefined,
          limit: HISTORY_PAGE_SIZE,
        }),
  );
  const candidates = findPullRequestLinks(history.messages);
  if (candidates.length === 0) {
    return available(sessionId, []);
  }

  const auth = await getGitHubClient(request, env);
  if (!auth || auth.userId !== userId) {
    return unavailable(sessionId);
  }

  const pullRequests = await mapWithConcurrency(
    candidates,
    GITHUB_READ_CONCURRENCY,
    (candidate) => verifyPullRequest(auth.client, candidate),
  );
  return available(sessionId, pullRequests.filter((pullRequest): pullRequest is HostedSessionPullRequest => pullRequest !== null));
}

function findPullRequestLinks(messages: readonly ConversationHistoryMessage[]): PullRequestCandidate[] {
  const candidates = new Map<string, PullRequestCandidate>();
  for (const message of messages) {
    for (const text of visibleText(message)) {
      PULL_REQUEST_URL.lastIndex = 0;
      for (const match of text.matchAll(PULL_REQUEST_URL)) {
        const owner = match[1];
        const repository = match[2];
        const number = Number(match[3]);
        if (!owner || !repository || !Number.isSafeInteger(number) || number <= 0) continue;
        const candidate = { owner, repository, number };
        const key = `${owner.toLowerCase()}/${repository.toLowerCase()}#${number}`;
        candidates.set(key, candidate);
      }
    }
  }
  return Array.from(candidates.values());
}

function visibleText(message: ConversationHistoryMessage): string[] {
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
}

async function verifyPullRequest(
  client: Pick<GitHubAPIClient, "getPullRequest">,
  candidate: PullRequestCandidate,
): Promise<HostedSessionPullRequest | null> {
  try {
    const pullRequest: PullRequest = await client.getPullRequest(
      candidate.owner,
      candidate.repository,
      candidate.number,
    );
    const returnedLink = parsePullRequestUrl(pullRequest.html_url);
    if (
      !returnedLink ||
      pullRequest.number !== candidate.number ||
      returnedLink.number !== candidate.number ||
      returnedLink.owner.toLowerCase() !== candidate.owner.toLowerCase() ||
      returnedLink.repository.toLowerCase() !== candidate.repository.toLowerCase() ||
      !pullRequest.title.trim()
    ) {
      throw new Error("GitHub returned mismatched pull request metadata");
    }
    return {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      state: pullRequest.merged_at ? "merged" : pullRequest.state,
      draft: pullRequest.draft,
    };
  } catch (error) {
    if (
      error instanceof GitHubAPIError &&
      (error.status === 404 || (error.status === 403 && !error.rateLimited))
    ) {
      return null;
    }
    throw error;
  }
}

function parsePullRequestUrl(value: string): PullRequestCandidate | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) {
      return null;
    }
    const match = url.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/.*)?$/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { owner: match[1], repository: match[2], number };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function available(
  sessionId: string,
  pullRequests: HostedSessionPullRequest[],
): HostedSessionPullRequestsResponse {
  return HostedSessionPullRequestsResponseSchema.parse({
    sessionId,
    status: "available",
    pullRequests,
  });
}

function unavailable(sessionId: string): HostedSessionPullRequestsResponse {
  return HostedSessionPullRequestsResponseSchema.parse({ sessionId, status: "unavailable" });
}
