/* eslint-disable react-hooks/immutability -- These refs are intentional mutable caches shared by the extracted controller hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ai-sdk/react";
import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { ActivityTurnViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { isTerminalRunStatus } from "../../../lib/run-status.js";
import { getGitDiff } from "../../../lib/git-client.js";
import {
  getEditArtifactDiff,
  getEditArtifactReviewSourceByMessage,
} from "../../../lib/edit-artifacts-client.js";
import { buildConversationTurns } from "../messageMetadata";
import {
  areFileStatusListsEqual,
  buildArtifactChangedFileDiffCacheKey,
  buildChangedFileDiffCacheKey,
  buildDiffFromActivityPreview,
  cloneFileStatuses,
  collectChangedFilesSinceBaseline,
  mergeChangedFileSnapshots,
} from "./changedFiles";
import { deriveActivityChangedFilesByAssistantMessageId } from "./chatEntries";
import {
  logClientEvent,
  logClientWarning,
} from "../../../lib/client-logger.js";

interface ChangedFilesControllerInput {
  messages: Message[];
  runId: string;
  sessionId: string;
  isLoading: boolean;
  summaryStatus?: string | null;
  gitFiles: FileStatus[];
  conversationTurns: ReturnType<typeof buildConversationTurns>;
  activityTurns: ActivityTurnViewModel[];
  hasScopedFeed: boolean;
}

type ArtifactLookupInput = Pick<
  ChangedFilesControllerInput,
  "isLoading" | "messages" | "runId" | "summaryStatus"
>;

const MAX_ARTIFACT_LOOKUP_ATTEMPTS = 3;
const ARTIFACT_LOOKUP_RETRY_DELAY_MS = 500;

export function useChangedFilesController(input: ChangedFilesControllerInput) {
  const [snapshots, setSnapshots] = useState<Record<string, FileStatus[]>>({});
  const [artifacts, setArtifacts] = useState<
    Record<string, PromptArtifactReviewSource>
  >({});
  const [artifactRetryVersion, setArtifactRetryVersion] = useState(0);
  const refs = useChangedFilesRefs(input.isLoading);
  const activitySnapshots = useMemo(
    () =>
      input.hasScopedFeed
        ? deriveActivityChangedFilesByAssistantMessageId(
            input.conversationTurns,
            input.activityTurns,
          )
        : {},
    [input.activityTurns, input.conversationTurns, input.hasScopedFeed],
  );
  const mergedSnapshots = useMemo(
    () => mergeChangedFileSnapshots(snapshots, activitySnapshots),
    [activitySnapshots, snapshots],
  );
  const latestAssistantMessageId = useMemo(
    () => findLatestAssistantMessageId(input.messages),
    [input.messages],
  );
  const loadChangedFileDiff = useChangedFileDiffLoader(
    input.runId,
    input.sessionId,
    artifacts,
    refs.diffCache,
  );
  const loadArtifactChangedFileDiff = useArtifactDiffLoader(refs.diffCache);
  const artifactLookupInput = useMemo<ArtifactLookupInput>(
    () => ({
      isLoading: input.isLoading,
      messages: input.messages,
      runId: input.runId,
      summaryStatus: input.summaryStatus,
    }),
    [input.isLoading, input.messages, input.runId, input.summaryStatus],
  );

  useEffect(
    () => () => {
      if (refs.artifactRetryTimer.current) {
        clearTimeout(refs.artifactRetryTimer.current);
      }
    },
    [refs],
  );

  useResetChangedFiles(
    input.runId,
    input.isLoading,
    refs,
    setSnapshots,
    setArtifacts,
  );
  useArtifactSources(
    artifactLookupInput,
    artifacts,
    artifactRetryVersion,
    refs,
    setArtifacts,
    setArtifactRetryVersion,
  );
  useChangedFileSnapshots(input, latestAssistantMessageId, refs, setSnapshots);

  return {
    snapshots: mergedSnapshots,
    artifacts,
    loadChangedFileDiff,
    loadArtifactChangedFileDiff,
  };
}

function useChangedFilesRefs(isLoading: boolean) {
  const pending = useRef<FileStatus[]>([]);
  const baseline = useRef<FileStatus[]>([]);
  const settled = useRef<FileStatus[]>([]);
  const previousLoading = useRef(isLoading);
  const diffCache = useRef<Record<string, DiffContent>>({});
  const inflightArtifacts = useRef<Set<string>>(new Set());
  const artifactAttempts = useRef<Map<string, number>>(new Map());
  const artifactRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useMemo(
    () => ({
      pending,
      baseline,
      settled,
      previousLoading,
      diffCache,
      inflightArtifacts,
      artifactAttempts,
      artifactRetryTimer,
    }),
    [],
  );
}

type ChangedFilesRefs = ReturnType<typeof useChangedFilesRefs>;

function useChangedFileDiffLoader(
  runId: string,
  sessionId: string,
  artifacts: Record<string, PromptArtifactReviewSource>,
  diffCache: ChangedFilesRefs["diffCache"],
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
        return loadCachedArtifactDiff(source.artifactId, file, diffCache);
      }
      const cacheKey = buildChangedFileDiffCacheKey(messageId, file);
      const cached = diffCache.current[cacheKey];
      if (cached) {
        logClientEvent("artifact/diff", "source-selected", {
          source: "message-cache",
          messageId,
          path: file.path,
        });
        return cached;
      }
      const preview = buildDiffFromActivityPreview(file);
      if (preview) {
        logClientEvent("artifact/diff", "source-selected", {
          source: "activity-preview",
          messageId,
          path: file.path,
        });
        diffCache.current[cacheKey] = preview;
        return preview;
      }
      logClientEvent("artifact/diff", "source-selected", {
        source: "live-git",
        messageId,
        path: file.path,
      });
      const diff = await getGitDiff({
        runId,
        sessionId,
        path: file.path,
        staged: file.isStaged,
      });
      diffCache.current[cacheKey] = diff;
      return diff;
    },
    [artifacts, diffCache, runId, sessionId],
  );
}

function useArtifactDiffLoader(diffCache: ChangedFilesRefs["diffCache"]) {
  return useCallback(
    (artifactId: string, file: FileStatus) =>
      loadCachedArtifactDiff(artifactId, file, diffCache),
    [diffCache],
  );
}

async function loadCachedArtifactDiff(
  artifactId: string,
  file: FileStatus,
  diffCache: ChangedFilesRefs["diffCache"],
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
  const response = await getEditArtifactDiff({ artifactId, path: file.path });
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
  isLoading: boolean,
  refs: ChangedFilesRefs,
  setSnapshots: React.Dispatch<
    React.SetStateAction<Record<string, FileStatus[]>>
  >,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
) {
  useEffect(() => {
    refs.pending.current = [];
    refs.baseline.current = [];
    refs.settled.current = [];
    refs.diffCache.current = {};
    refs.inflightArtifacts.current = new Set();
    refs.artifactAttempts.current = new Map();
    if (refs.artifactRetryTimer.current) {
      clearTimeout(refs.artifactRetryTimer.current);
      refs.artifactRetryTimer.current = null;
    }
    refs.previousLoading.current = false;
    setSnapshots({});
    setArtifacts({});
    logClientEvent("artifact/state", "scope-reset", { runId });
  }, [refs, runId, setArtifacts, setSnapshots]);
  useEffect(() => {
    if (!refs.previousLoading.current && isLoading) {
      refs.baseline.current = cloneFileStatuses(refs.settled.current);
      refs.pending.current = [];
      refs.diffCache.current = {};
    }
    refs.previousLoading.current = isLoading;
  }, [isLoading, refs]);
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
    const ids = selectArtifactLookupIds(input, artifacts, refs);
    if (!input.runId || ids.length === 0) return;
    markArtifactLookupsStarted(ids, refs);
    logClientEvent("artifact/hydration", "batch-started", {
      runId: input.runId,
      messageCount: ids.length,
      retryVersion: artifactRetryVersion,
    });
    let cancelled = false;
    void fetchArtifactSources(input.runId, ids).then((results) => {
      if (cancelled) return;
      applyArtifactLookupResults(
        results,
        ids,
        input,
        refs,
        setArtifacts,
        setArtifactRetryVersion,
      );
    });
    return () => {
      cancelled = true;
      ids.forEach((id) => refs.inflightArtifacts.current.delete(id));
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
): string[] {
  const canRetry = canRetryArtifactLookups(input);
  return input.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.id)
    .filter((id) => {
      const attempts = refs.artifactAttempts.current.get(id) ?? 0;
      return (
        !artifacts[id] &&
        !refs.inflightArtifacts.current.has(id) &&
        (attempts === 0 || canRetry) &&
        attempts < MAX_ARTIFACT_LOOKUP_ATTEMPTS
      );
    });
}

function markArtifactLookupsStarted(
  ids: string[],
  refs: ChangedFilesRefs,
): void {
  ids.forEach((id) => {
    refs.inflightArtifacts.current.add(id);
    refs.artifactAttempts.current.set(
      id,
      (refs.artifactAttempts.current.get(id) ?? 0) + 1,
    );
  });
}

function fetchArtifactSources(runId: string, ids: string[]) {
  return Promise.allSettled(
    ids.map(
      async (id) =>
        [
          id,
          await getEditArtifactReviewSourceByMessage({
            runId,
            assistantMessageId: id,
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

function applyArtifactLookupResults(
  results: Awaited<ReturnType<typeof fetchArtifactSources>>,
  ids: string[],
  input: ArtifactLookupInput,
  refs: ChangedFilesRefs,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
  setArtifactRetryVersion: React.Dispatch<React.SetStateAction<number>>,
): void {
  const entries: Array<[string, PromptArtifactReviewSource]> = [];
  results.forEach((result, index) =>
    collectArtifactResult(result, ids[index], refs, entries),
  );
  if (entries.length > 0) {
    setArtifacts((current) => ({
      ...current,
      ...Object.fromEntries(entries),
    }));
  }
  if (!shouldRetryArtifactLookup(results, ids, input, refs)) return;
  logClientEvent("artifact/hydration", "retry-scheduled", {
    runId: input.runId,
    messageCount: ids.length,
    delayMs: ARTIFACT_LOOKUP_RETRY_DELAY_MS,
  });
  refs.artifactRetryTimer.current = setTimeout(() => {
    refs.artifactRetryTimer.current = null;
    setArtifactRetryVersion((version) => version + 1);
  }, ARTIFACT_LOOKUP_RETRY_DELAY_MS);
}

function shouldRetryArtifactLookup(
  results: PromiseSettledResult<
    readonly [string, PromptArtifactReviewSource | null]
  >[],
  ids: string[],
  input: ArtifactLookupInput,
  refs: ChangedFilesRefs,
): boolean {
  if (!canRetryArtifactLookups(input) || refs.artifactRetryTimer.current) {
    return false;
  }
  return results.some((result, index) => {
    const id = ids[index];
    if (!id) return false;
    const missing = result.status === "rejected" || result.value[1] === null;
    return (
      missing &&
      (refs.artifactAttempts.current.get(id) ?? 0) <
        MAX_ARTIFACT_LOOKUP_ATTEMPTS
    );
  });
}

function collectArtifactResult(
  result: PromiseSettledResult<
    readonly [string, PromptArtifactReviewSource | null]
  >,
  id: string | undefined,
  refs: ChangedFilesRefs,
  entries: Array<[string, PromptArtifactReviewSource]>,
): void {
  if (!id) return;
  refs.inflightArtifacts.current.delete(id);
  if (result.status === "fulfilled" && result.value[1]) {
    const source = result.value[1];
    logClientEvent("artifact/hydration", "message-resolved", {
      requestedMessageId: id,
      returnedMessageId: source.assistantMessageId ?? null,
      artifactId: source.artifactId,
      fileCount: source.files.length,
      attempt: refs.artifactAttempts.current.get(id) ?? 0,
    });
    entries.push([id, result.value[1]]);
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
  refs: ChangedFilesRefs,
  setSnapshots: React.Dispatch<
    React.SetStateAction<Record<string, FileStatus[]>>
  >,
) {
  useEffect(() => {
    if (!input.isLoading)
      refs.settled.current = cloneFileStatuses(input.gitFiles);
    if (input.gitFiles.length > 0)
      refs.pending.current = collectChangedFilesSinceBaseline(
        input.gitFiles,
        refs.baseline.current,
      );
  }, [input.gitFiles, input.isLoading, refs]);
  useEffect(() => {
    if (input.isLoading || !latestAssistantMessageId) return;
    const changed =
      refs.pending.current.length > 0
        ? refs.pending.current
        : collectChangedFilesSinceBaseline(
            input.gitFiles,
            refs.baseline.current,
          );
    if (changed.length === 0) return;
    logClientEvent("artifact/snapshot", "assigned", {
      runId: input.runId,
      assistantMessageId: latestAssistantMessageId,
      fileCount: changed.length,
      source: refs.pending.current.length > 0 ? "pending-git" : "live-git",
    });
    setSnapshots((current) => {
      const next = cloneFileStatuses(changed);
      return areFileStatusListsEqual(current[latestAssistantMessageId], next)
        ? current
        : { ...current, [latestAssistantMessageId]: next };
    });
  }, [
    input.gitFiles,
    input.isLoading,
    latestAssistantMessageId,
    refs,
    setSnapshots,
  ]);
}

function findLatestAssistantMessageId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant")
      return messages[index]?.id ?? null;
  }
  return null;
}
