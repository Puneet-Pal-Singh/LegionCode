/* eslint-disable react-hooks/immutability -- These refs are intentional mutable caches shared by the extracted controller hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ai-sdk/react";
import type {
  DiffContent,
  EditArtifactIdentity,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { EditArtifactIdentitySchema } from "@repo/shared-types";
import { isTerminalRunStatus } from "../../../lib/run-status.js";
import {
  getEditArtifactDiff,
  getEditArtifactReviewSourceByMessageWithStatus,
} from "../../../lib/edit-artifacts-client.js";
import {
  areFileStatusListsEqual,
  buildArtifactChangedFileDiffCacheKey,
  cloneFileStatuses,
} from "./changedFiles";
import {
  logClientEvent,
  logClientWarning,
} from "../../../lib/client-logger.js";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";
import { buildDiffContentFromTurnDiff } from "../../../services/lifecycle/TurnDiffPatchParser.js";

interface ChangedFilesControllerInput {
  messages: Message[];
  runId: string;
  isLoading: boolean;
  summaryStatus?: string | null;
  turnDiff: TurnDiffPayload | null;
  artifactIdentity?: EditArtifactIdentity | null;
}

type ArtifactLookupInput = Pick<
  ChangedFilesControllerInput,
  "isLoading" | "messages" | "runId" | "summaryStatus" | "artifactIdentity"
>;

const MAX_ARTIFACT_LOOKUP_ATTEMPTS = 3;
const ARTIFACT_LOOKUP_RETRY_DELAY_MS = 500;

interface ArtifactLookupRequest {
  messageId: string;
  identity: EditArtifactIdentity;
}

export function useChangedFilesController(input: ChangedFilesControllerInput) {
  const [snapshots, setSnapshots] = useState<Record<string, FileStatus[]>>({});
  const [artifacts, setArtifacts] = useState<
    Record<string, PromptArtifactReviewSource>
  >({});
  const [artifactRetryVersion, setArtifactRetryVersion] = useState(0);
  const refs = useChangedFilesRefs();
  const latestAssistantMessageId = useMemo(
    () => findLatestAssistantMessageId(input.messages),
    [input.messages],
  );
  const loadChangedFileDiff = useChangedFileDiffLoader(
    artifacts,
    refs.diffCache,
    input.turnDiff,
    latestAssistantMessageId,
  );
  const loadArtifactChangedFileDiff = useArtifactDiffLoader(
    refs.diffCache,
    input.artifactIdentity,
  );
  const artifactLookupInput = useMemo<ArtifactLookupInput>(
    () => ({
      isLoading: input.isLoading,
      messages: input.messages,
      runId: input.runId,
      summaryStatus: input.summaryStatus,
      artifactIdentity: input.artifactIdentity,
    }),
    [
      input.artifactIdentity,
      input.isLoading,
      input.messages,
      input.runId,
      input.summaryStatus,
    ],
  );

  useEffect(
    () => () => {
      if (refs.artifactRetryTimer.current) {
        clearTimeout(refs.artifactRetryTimer.current);
      }
    },
    [refs],
  );

  useResetChangedFiles(input.runId, refs, setSnapshots, setArtifacts);
  useArtifactSources(
    artifactLookupInput,
    artifacts,
    artifactRetryVersion,
    refs,
    setArtifacts,
    setArtifactRetryVersion,
  );
  useChangedFileSnapshots(input, latestAssistantMessageId, setSnapshots);

  return {
    snapshots,
    artifacts,
    loadChangedFileDiff,
    loadArtifactChangedFileDiff,
  };
}

function useChangedFilesRefs() {
  const diffCache = useRef<Record<string, DiffContent>>({});
  const inflightArtifacts = useRef<Set<string>>(new Set());
  const artifactAttempts = useRef<Map<string, number>>(new Map());
  const terminalNoArtifactMessageIds = useRef<Set<string>>(new Set());
  const artifactRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useMemo(
    () => ({
      diffCache,
      inflightArtifacts,
      artifactAttempts,
      terminalNoArtifactMessageIds,
      artifactRetryTimer,
    }),
    [],
  );
}

type ChangedFilesRefs = ReturnType<typeof useChangedFilesRefs>;

function useChangedFileDiffLoader(
  artifacts: Record<string, PromptArtifactReviewSource>,
  diffCache: ChangedFilesRefs["diffCache"],
  turnDiff: TurnDiffPayload | null,
  turnDiffMessageId: string | null,
) {
  return useCallback(
    async (messageId: string, file: FileStatus): Promise<DiffContent> => {
      const source = artifacts[messageId];
      if (source) {
        logClientEvent("artifact/diff", "source-selected", {
          source: "saved-artifact",
          messageId,
          artifactId: source.artifactId,
          path: file.path,
        });
        return loadCachedArtifactDiff(
          source.artifactId,
          file,
          diffCache,
          source,
        );
      }

      if (turnDiff && messageId === turnDiffMessageId) {
        const diff = buildDiffContentFromTurnDiff(turnDiff, file.path);
        if (diff) {
          logClientEvent("artifact/diff", "source-selected", {
            source: "canonical-turn-diff",
            messageId,
            path: file.path,
          });
          return diff;
        }
      }

      throw new Error(`Turn-owned diff for ${file.path} is unavailable.`);
    },
    [artifacts, diffCache, turnDiff, turnDiffMessageId],
  );
}

function useArtifactDiffLoader(
  diffCache: ChangedFilesRefs["diffCache"],
  identity: EditArtifactIdentity | null | undefined,
) {
  return useCallback(
    (artifactId: string, file: FileStatus) => {
      if (!identity) {
        return Promise.reject(
          new Error(`Turn identity is required to load ${file.path}.`),
        );
      }
      return loadCachedArtifactDiff(artifactId, file, diffCache, identity);
    },
    [diffCache, identity],
  );
}

async function loadCachedArtifactDiff(
  artifactId: string,
  file: FileStatus,
  diffCache: ChangedFilesRefs["diffCache"],
  identity: EditArtifactIdentity,
): Promise<DiffContent> {
  const cacheKey = buildArtifactChangedFileDiffCacheKey(artifactId, file);
  const cached = diffCache.current[cacheKey];
  if (cached) {
    logClientEvent("artifact/diff", "cache-hit", {
      artifactId,
      path: file.path,
    });
    return cached;
  }
  logClientEvent("artifact/diff", "fetching", {
    artifactId,
    path: file.path,
  });
  const response = await getEditArtifactDiff({
    artifactId,
    path: file.path,
    identity,
  });
  diffCache.current[cacheKey] = response.diff;
  logClientEvent("artifact/diff", "loaded", {
    artifactId,
    path: file.path,
    hunkCount: response.diff.hunks.length,
  });
  return response.diff;
}

function useResetChangedFiles(
  runId: string,
  refs: ChangedFilesRefs,
  setSnapshots: React.Dispatch<
    React.SetStateAction<Record<string, FileStatus[]>>
  >,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
) {
  useEffect(() => {
    refs.diffCache.current = {};
    refs.inflightArtifacts.current = new Set();
    refs.artifactAttempts.current = new Map();
    refs.terminalNoArtifactMessageIds.current = new Set();
    if (refs.artifactRetryTimer.current) {
      clearTimeout(refs.artifactRetryTimer.current);
      refs.artifactRetryTimer.current = null;
    }
    setSnapshots({});
    setArtifacts({});
    logClientEvent("artifact/state", "scope-reset", { runId });
  }, [refs, runId, setArtifacts, setSnapshots]);
}

function useArtifactSources(
  input: ArtifactLookupInput,
  artifacts: Record<string, PromptArtifactReviewSource>,
  artifactRetryVersion: number,
  refs: ChangedFilesRefs,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
  setArtifactRetryVersion: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    const requests = selectArtifactLookupIds(input, artifacts, refs);
    if (!input.runId || requests.length === 0) return;
    markArtifactLookupsStarted(requests, refs);
    logClientEvent("artifact/hydration", "batch-started", {
      runId: input.runId,
      messageCount: requests.length,
      retryVersion: artifactRetryVersion,
    });
    let cancelled = false;
    void fetchArtifactSources(input.runId, requests).then((results) => {
      if (cancelled) return;
      applyArtifactLookupResults(
        results,
        requests,
        input,
        refs,
        setArtifacts,
        setArtifactRetryVersion,
      );
    });
    return () => {
      cancelled = true;
      requests.forEach(({ messageId }) =>
        refs.inflightArtifacts.current.delete(messageId),
      );
    };
  }, [
    artifacts,
    artifactRetryVersion,
    input,
    refs,
    setArtifactRetryVersion,
    setArtifacts,
  ]);
}

function selectArtifactLookupIds(
  input: ArtifactLookupInput,
  artifacts: Record<string, PromptArtifactReviewSource>,
  refs: ChangedFilesRefs,
): ArtifactLookupRequest[] {
  const canRetry = canRetryArtifactLookups(input);
  const latestAssistantMessageId = findLatestAssistantMessageId(input.messages);
  return input.messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      messageId: message.id,
      identity: resolveMessageArtifactIdentity(
        message,
        message.id === latestAssistantMessageId ? input.artifactIdentity : null,
      ),
    }))
    .filter((request): request is ArtifactLookupRequest => {
      if (!request.identity) return false;
      const attempts =
        refs.artifactAttempts.current.get(request.messageId) ?? 0;
      return (
        !artifacts[request.messageId] &&
        !refs.inflightArtifacts.current.has(request.messageId) &&
        !refs.terminalNoArtifactMessageIds.current.has(request.messageId) &&
        (attempts === 0 || canRetry) &&
        attempts < MAX_ARTIFACT_LOOKUP_ATTEMPTS
      );
    });
}

function markArtifactLookupsStarted(
  requests: ArtifactLookupRequest[],
  refs: ChangedFilesRefs,
): void {
  requests.forEach(({ messageId }) => {
    refs.inflightArtifacts.current.add(messageId);
    refs.artifactAttempts.current.set(
      messageId,
      (refs.artifactAttempts.current.get(messageId) ?? 0) + 1,
    );
  });
}

function fetchArtifactSources(
  runId: string,
  requests: ArtifactLookupRequest[],
) {
  return Promise.allSettled(
    requests.map(
      async (request) =>
        [
          request.messageId,
          await getEditArtifactReviewSourceByMessageWithStatus({
            runId,
            assistantMessageId: request.messageId,
            identity: request.identity,
          }),
        ] as const,
    ),
  );
}

function canRetryArtifactLookups(input: ArtifactLookupInput): boolean {
  return Boolean(
    !input.isLoading &&
    input.summaryStatus &&
    isTerminalRunStatus(input.summaryStatus),
  );
}

function resolveMessageArtifactIdentity(
  message: Message,
  activeIdentity: EditArtifactIdentity | null | undefined,
): EditArtifactIdentity | null {
  const data = (message as Message & { data?: unknown }).data;
  if (data && typeof data === "object" && "metadata" in data) {
    const metadata = (data as { metadata?: unknown }).metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      "artifactScope" in metadata
    ) {
      const parsed = EditArtifactIdentitySchema.safeParse(
        (metadata as { artifactScope?: unknown }).artifactScope,
      );
      if (parsed.success) return parsed.data;
    }
  }
  return activeIdentity ?? null;
}

function applyArtifactLookupResults(
  results: Awaited<ReturnType<typeof fetchArtifactSources>>,
  requests: ArtifactLookupRequest[],
  input: ArtifactLookupInput,
  refs: ChangedFilesRefs,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
  setArtifactRetryVersion: React.Dispatch<React.SetStateAction<number>>,
): void {
  const entries: Array<[string, PromptArtifactReviewSource]> = [];
  results.forEach((result, index) =>
    collectArtifactResult(result, requests[index]?.messageId, refs, entries),
  );
  if (entries.length > 0) {
    setArtifacts((current) => ({
      ...current,
      ...Object.fromEntries(entries),
    }));
  }
  if (!shouldRetryArtifactLookup(results, requests, input, refs)) return;
  logClientEvent("artifact/hydration", "retry-scheduled", {
    runId: input.runId,
    messageCount: requests.length,
    delayMs: ARTIFACT_LOOKUP_RETRY_DELAY_MS,
  });
  refs.artifactRetryTimer.current = setTimeout(() => {
    refs.artifactRetryTimer.current = null;
    setArtifactRetryVersion((version) => version + 1);
  }, ARTIFACT_LOOKUP_RETRY_DELAY_MS);
}

function shouldRetryArtifactLookup(
  results: PromiseSettledResult<
    readonly [
      string,
      { source: PromptArtifactReviewSource | null; status: number },
    ]
  >[],
  requests: ArtifactLookupRequest[],
  input: ArtifactLookupInput,
  refs: ChangedFilesRefs,
): boolean {
  if (!canRetryArtifactLookups(input) || refs.artifactRetryTimer.current) {
    return false;
  }
  return results.some((result, index) => {
    const id = requests[index]?.messageId;
    if (!id) return false;
    if (result.status === "fulfilled" && result.value[1].status === 204) {
      refs.terminalNoArtifactMessageIds.current.add(id);
      return false;
    }
    const missing =
      result.status === "rejected" || result.value[1].source === null;
    return (
      missing &&
      (refs.artifactAttempts.current.get(id) ?? 0) <
        MAX_ARTIFACT_LOOKUP_ATTEMPTS
    );
  });
}

function collectArtifactResult(
  result: PromiseSettledResult<
    readonly [
      string,
      { source: PromptArtifactReviewSource | null; status: number },
    ]
  >,
  id: string | undefined,
  refs: ChangedFilesRefs,
  entries: Array<[string, PromptArtifactReviewSource]>,
): void {
  if (!id) return;
  refs.inflightArtifacts.current.delete(id);
  if (result.status === "fulfilled" && result.value[1].source) {
    const source = result.value[1].source;
    logClientEvent("artifact/hydration", "message-resolved", {
      requestedMessageId: id,
      returnedMessageId: source.assistantMessageId ?? null,
      artifactId: source.artifactId,
      fileCount: source.files.length,
      attempt: refs.artifactAttempts.current.get(id) ?? 0,
    });
    entries.push([id, source]);
    return;
  }
  if (result.status === "rejected") {
    logClientWarning("artifact/hydration", "message-failed", {
      assistantMessageId: id,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      attempt: refs.artifactAttempts.current.get(id) ?? 0,
    });
    return;
  }
  logClientEvent("artifact/hydration", "message-missing", {
    assistantMessageId: id,
    attempt: refs.artifactAttempts.current.get(id) ?? 0,
  });
}

function useChangedFileSnapshots(
  input: ChangedFilesControllerInput,
  latestAssistantMessageId: string | null,
  setSnapshots: React.Dispatch<
    React.SetStateAction<Record<string, FileStatus[]>>
  >,
) {
  useEffect(() => {
    if (!input.isLoading && input.turnDiff && latestAssistantMessageId) {
      const files = input.turnDiff.files.map(mapTurnDiffFileToStatus);
      if (files.length === 0) return;
      logClientEvent("artifact/snapshot", "assigned", {
        runId: input.runId,
        assistantMessageId: latestAssistantMessageId,
        fileCount: files.length,
        source: "canonical-turn-diff",
      });
      setSnapshots((current) => {
        const next = cloneFileStatuses(files);
        return areFileStatusListsEqual(current[latestAssistantMessageId], next)
          ? current
          : { ...current, [latestAssistantMessageId]: next };
      });
      return;
    }
  }, [
    input.isLoading,
    input.runId,
    input.turnDiff,
    latestAssistantMessageId,
    setSnapshots,
  ]);
}

function mapTurnDiffFileToStatus(
  file: TurnDiffPayload["files"][number],
): FileStatus {
  return {
    path: file.path,
    status: (file.status ?? "modified") as FileStatus["status"],
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    isStaged: false,
  };
}

function findLatestAssistantMessageId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant")
      return messages[index]?.id ?? null;
  }
  return null;
}
