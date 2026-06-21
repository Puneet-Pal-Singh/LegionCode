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

export function useChangedFilesController(input: ChangedFilesControllerInput) {
  const [snapshots, setSnapshots] = useState<Record<string, FileStatus[]>>({});
  const [artifacts, setArtifacts] = useState<
    Record<string, PromptArtifactReviewSource>
  >({});
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

  useResetChangedFiles(
    input.runId,
    input.isLoading,
    refs,
    setSnapshots,
    setArtifacts,
  );
  useArtifactSources(input, artifacts, refs, setArtifacts);
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
  const artifactMisses = useRef<Set<string>>(new Set());
  const inflightArtifacts = useRef<Set<string>>(new Set());
  return useMemo(
    () => ({
      pending,
      baseline,
      settled,
      previousLoading,
      diffCache,
      artifactMisses,
      inflightArtifacts,
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
      if (source)
        return loadCachedArtifactDiff(source.artifactId, file, diffCache);
      const cacheKey = buildChangedFileDiffCacheKey(messageId, file);
      const cached = diffCache.current[cacheKey];
      if (cached) return cached;
      const preview = buildDiffFromActivityPreview(file);
      if (preview) {
        diffCache.current[cacheKey] = preview;
        return preview;
      }
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
  if (cached) return cached;
  const response = await getEditArtifactDiff({ artifactId, path: file.path });
  diffCache.current[cacheKey] = response.diff;
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
    refs.artifactMisses.current = new Set();
    refs.inflightArtifacts.current = new Set();
    refs.previousLoading.current = false;
    setSnapshots({});
    setArtifacts({});
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
  input: ChangedFilesControllerInput,
  artifacts: Record<string, PromptArtifactReviewSource>,
  refs: ChangedFilesRefs,
  setArtifacts: React.Dispatch<
    React.SetStateAction<Record<string, PromptArtifactReviewSource>>
  >,
) {
  useEffect(() => {
    const ids = input.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id)
      .filter(
        (id) =>
          !artifacts[id] &&
          !refs.artifactMisses.current.has(id) &&
          !refs.inflightArtifacts.current.has(id),
      );
    if (!input.runId || ids.length === 0) return;
    ids.forEach((id) => refs.inflightArtifacts.current.add(id));
    let cancelled = false;
    void Promise.allSettled(
      ids.map(
        async (id) =>
          [
            id,
            await getEditArtifactReviewSourceByMessage({
              runId: input.runId,
              assistantMessageId: id,
            }),
          ] as const,
      ),
    ).then((results) => {
      if (cancelled) return;
      const entries: Array<[string, PromptArtifactReviewSource]> = [];
      results.forEach((result, index) =>
        collectArtifactResult(result, ids[index], input, refs, entries),
      );
      if (entries.length > 0)
        setArtifacts((current) => ({
          ...current,
          ...Object.fromEntries(entries),
        }));
    });
    return () => {
      cancelled = true;
    };
    // The scalar input fields below are the complete fetch dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    artifacts,
    input.isLoading,
    input.messages,
    input.runId,
    input.summaryStatus,
    refs,
    setArtifacts,
  ]);
}

function collectArtifactResult(
  result: PromiseSettledResult<
    readonly [string, PromptArtifactReviewSource | null]
  >,
  id: string | undefined,
  input: ChangedFilesControllerInput,
  refs: ChangedFilesRefs,
  entries: Array<[string, PromptArtifactReviewSource]>,
): void {
  if (!id) return;
  refs.inflightArtifacts.current.delete(id);
  if (result.status === "fulfilled" && result.value[1]) {
    entries.push([id, result.value[1]]);
    return;
  }
  if (result.status === "rejected")
    console.warn("[chat/artifacts] Failed to hydrate artifact", {
      assistantMessageId: id,
      error: result.reason,
    });
  const cacheFailure =
    !input.isLoading &&
    Boolean(input.summaryStatus && isTerminalRunStatus(input.summaryStatus));
  if (
    (result.status === "fulfilled" && result.value[1] === null) ||
    (cacheFailure && result.status === "rejected")
  )
    refs.artifactMisses.current.add(id);
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
