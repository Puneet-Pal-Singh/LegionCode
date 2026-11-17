import {
  shouldRetainCurrentTitleProjection,
  usePendingTitleProjectionRefresh,
} from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { LocalWorkspaceGrant, Thread } from "@repo/platform-protocol";
import { useCallback, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

type TitleClient = Pick<AppServerClient, "listThreads" | "getWorkspaceGrant">;
type ReadScope = {
  readonly client: TitleClient | null;
  readonly workspaceId: LocalWorkspaceGrant["workspaceId"] | undefined;
  readonly grantedAt: LocalWorkspaceGrant["grantedAt"] | undefined;
  readonly repositoryIdentity: LocalWorkspaceGrant["repositoryIdentity"] | undefined;
  readonly readiness: LocalWorkspaceGrant["readiness"] | undefined;
};
type TitleRead = { scope: ReadScope; generation: number; threads: Thread[] };
const getRecords = (read: TitleRead) => read.threads;
const onError = () => console.warn("Desktop pending title projections could not be refreshed");

/** Refresh only canonical title fields; navigation, grants and runtime state keep their owners. */
export function useDesktopPendingTitleProjectionRefresh(input: {
  client: TitleClient | null;
  enabled: boolean;
  workspace: LocalWorkspaceGrant | null;
  threads: Thread[];
  generation: RefObject<number>;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setSelectedThread: Dispatch<SetStateAction<Thread | null>>;
}): void {
  const scope = useMemo<ReadScope>(() => ({
    client: input.client,
    workspaceId: input.workspace?.workspaceId,
    grantedAt: input.workspace?.grantedAt,
    repositoryIdentity: input.workspace?.repositoryIdentity,
    readiness: input.workspace?.readiness,
  }), [input.client, input.workspace?.workspaceId, input.workspace?.grantedAt,
    input.workspace?.repositoryIdentity, input.workspace?.readiness]);
  const latest = useRef({ scope, enabled: input.enabled });
  latest.current = { scope, enabled: input.enabled };
  const generation = input.generation;
  const current = useCallback((read: Pick<TitleRead, "scope" | "generation">) =>
    latest.current.enabled && latest.current.scope === read.scope && generation.current === read.generation,
  [generation]);
  const readProjection = useCallback(async (): Promise<TitleRead> => {
    const read = { scope, generation: generation.current };
    if (!current(read) || !scope.client || scope.readiness !== "ready")
      throw new Error("Desktop title read scope is unavailable");
    const threads = await scope.client.listThreads();
    if (!current(read)) throw new Error("Desktop title read scope changed");
    const grant = await scope.client.getWorkspaceGrant();
    if (!current(read) || !grant || grant.readiness !== "ready" ||
        grant.workspaceId !== scope.workspaceId || grant.grantedAt !== scope.grantedAt ||
        grant.repositoryIdentity !== scope.repositoryIdentity)
      throw new Error("Desktop title read scope changed");
    return { ...read, threads };
  }, [scope, generation, current]);
  const { setThreads, setSelectedThread } = input;
  const onProjection = useCallback((read: TitleRead) => {
    if (!current(read)) return;
    const byId = new Map(read.threads.map((thread) => [thread.id, thread]));
    const merge = (thread: Thread): Thread => {
      const incoming = byId.get(thread.id);
      if (!incoming || incoming.workspaceId !== read.scope.workspaceId ||
          incoming.workspaceId !== thread.workspaceId || incoming.userId !== thread.userId ||
          shouldRetainCurrentTitleProjection(thread, incoming) ||
          (thread.title === incoming.title && thread.titleSource === incoming.titleSource &&
            thread.titleVersion === incoming.titleVersion && thread.titleStatus === incoming.titleStatus)) return thread;
      return {
        ...thread,
        title: incoming.title, titleSource: incoming.titleSource,
        titleVersion: incoming.titleVersion, titleStatus: incoming.titleStatus,
        updatedAt: incoming.updatedAt > thread.updatedAt ? incoming.updatedAt : thread.updatedAt,
      };
    };
    setThreads((threads) => {
      if (!current(read)) return threads;
      const next = threads.map(merge);
      return next.some((thread, index) => thread !== threads[index]) ? next : threads;
    });
    setSelectedThread((thread) => current(read) && thread ? merge(thread) : thread);
  }, [current, setThreads, setSelectedThread]);

  usePendingTitleProjectionRefresh({
    enabled: input.enabled && scope.readiness === "ready" && Boolean(scope.client),
    scopeKey: JSON.stringify([scope.workspaceId, scope.grantedAt, scope.repositoryIdentity, generation.current]),
    records: input.threads,
    readProjection, getRecords, onProjection, onError,
  });
}
