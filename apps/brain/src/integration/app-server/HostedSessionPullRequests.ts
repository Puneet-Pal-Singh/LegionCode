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
const PULL_REQUEST_URL = /(?<![A-Za-z0-9_@./?&=#%-])https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?:[^\s<>{}()[\]"'`]*)/gi;

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
  const signal = request.signal;
  const firstPage = await readHostedConversationHistory(env, userId, {
    session: sessionId,
    limit: HISTORY_PAGE_SIZE,
  }, signal);
  const history = await readConversationHistory<ConversationHistoryMessage>(
    (cursor, snapshot, pageSignal) => cursor === null
      ? Promise.resolve(firstPage)
      : readHostedConversationHistory(env, userId, {
          session: sessionId,
          cursor: cursor ?? undefined,
          snapshot: snapshot ?? undefined,
          limit: HISTORY_PAGE_SIZE,
        }, pageSignal),
    { signal },
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
    (candidate) => verifyPullRequest(auth.client, candidate, signal),
  );
  return available(sessionId, pullRequests.filter((pullRequest): pullRequest is HostedSessionPullRequest => pullRequest !== null));
}

function findPullRequestLinks(messages: readonly ConversationHistoryMessage[]): PullRequestCandidate[] {
  const candidates = new Map<string, PullRequestCandidate>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const text of visibleText(message)) {
      PULL_REQUEST_URL.lastIndex = 0;
      for (const match of text.matchAll(PULL_REQUEST_URL)) {
        const link = normalizePullRequestLink(match[0]);
        if (!link) continue;
        const candidate = link;
        const { owner, repository, number } = candidate;
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
  signal: AbortSignal,
): Promise<HostedSessionPullRequest | null> {
  if (signal.aborted) throw new Error("Pull request query was cancelled");
  try {
    const pullRequest: PullRequest = await client.getPullRequest(
      candidate.owner,
      candidate.repository,
      candidate.number,
      signal,
    );
    const returnedLink = parsePullRequestUrl(pullRequest.html_url, false);
    if (
      !returnedLink ||
      pullRequest.number !== candidate.number ||
      returnedLink.number !== candidate.number ||
      returnedLink.owner.toLowerCase() !== candidate.owner.toLowerCase() ||
      returnedLink.repository.toLowerCase() !== candidate.repository.toLowerCase() ||
      typeof pullRequest.title !== "string" ||
      !pullRequest.title.trim() ||
      (pullRequest.state !== "open" && pullRequest.state !== "closed") ||
      typeof pullRequest.draft !== "boolean" ||
      !(pullRequest.merged_at === null || isValidTimestamp(pullRequest.merged_at))
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

function normalizePullRequestLink(value: string): PullRequestCandidate | null {
  let candidate = value;
  while (candidate && /[.,!?;:)]$/.test(candidate)) candidate = candidate.slice(0, -1);
  return parsePullRequestUrl(candidate);
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function parsePullRequestUrl(value: string, allowSubpath = true): PullRequestCandidate | null {
  try {
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    const url = new URL(value);
    if (url.protocol !== "https:" || !authority || authority.toLowerCase() !== "github.com" || url.hostname !== "github.com" || url.port || url.username || url.password) {
      return null;
    }
    const match = url.pathname.match(allowSubpath
      ? /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/.*)?$/
      : /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/);
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
  let stop = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stop) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = await map(values[index]!);
      } catch (error) {
        stop = true;
        throw error;
      }
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
