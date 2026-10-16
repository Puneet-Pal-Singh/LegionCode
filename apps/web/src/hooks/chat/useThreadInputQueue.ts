import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceScopeIdSchema,
  type ThreadInputQueueSnapshot,
  type ThreadInputReceipt,
} from "@repo/platform-client-sdk";
import type { ConversationScope } from "../conversationScope";
import { createLifecycleClient } from "../../services/api/lifecycleClient";

export function useThreadInputQueue(
  scope: ConversationScope | null,
  activeTarget: { turnId: string; runAttemptId: string } | null,
  invalidationKey: string,
) {
  const client = useMemo(() => createLifecycleClient(), []);
  const [snapshotState, setSnapshotState] = useState<{
    scopeKey: string;
    value: ThreadInputQueueSnapshot;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = scope
    ? `${scope.sessionId}:${scope.runId}:${scope.workspaceId}:${scope.threadId}`
    : null;
  const scopeKeyRef = useRef(scopeKey);
  const requestVersionRef = useRef(0);
  const snapshotRef = useRef<{
    scopeKey: string;
    value: ThreadInputQueueSnapshot;
  } | null>(null);

  const snapshot =
    snapshotState?.scopeKey === scopeKey ? snapshotState.value : null;
  const hasPendingItems = Boolean(
    snapshot &&
    snapshot.items.some(
      (item) =>
        item.receipt?.status !== "unconfirmed" &&
        (item.state === "consuming" ||
          (item.state === "pending" &&
            (item.delivery === "steer" || !snapshot.paused))),
    ),
  );

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    requestVersionRef.current += 1;
    snapshotRef.current = null;
    setSnapshotState(null);
    setError(null);
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    if (!scope) return null;
    const capturedKey = scopeKey;
    const requestVersion = ++requestVersionRef.current;
    try {
      const next = await client.listThreadInputs({
        operation: "thread.input.list",
        threadId: ThreadIdSchema.parse(scope.threadId),
        workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
        ...(snapshotRef.current?.scopeKey === capturedKey
          ? { knownRevision: snapshotRef.current.value.revision }
          : {}),
      });
      if (
        scopeKeyRef.current !== capturedKey ||
        requestVersionRef.current !== requestVersion
      ) {
        return null;
      }
      const nextState = { scopeKey: capturedKey!, value: next };
      setSnapshotState(nextState);
      snapshotRef.current = nextState;
      setError(null);
      return next;
    } catch (requestError) {
      if (scopeKeyRef.current === capturedKey) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Queued inputs could not be loaded.",
        );
      }
      return null;
    }
  }, [client, scope, scopeKey]);

  useEffect(() => {
    if (scope) void refresh();
  }, [refresh, scope, invalidationKey]);

  useEffect(() => {
    if (!scope || (!activeTarget && !hasPendingItems)) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("online", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("online", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [activeTarget, hasPendingItems, refresh, scope]);

  const runMutation = useCallback(
    async (
      action: () => Promise<ThreadInputReceipt>,
    ): Promise<ThreadInputReceipt | null> => {
      const capturedKey = scopeKey;
      try {
        const receipt = await action();
        if (scopeKeyRef.current !== capturedKey) return null;
        if (receipt.status === "conflict") {
          setError(receipt.message);
        } else {
          setError(null);
        }
        await refresh();
        return receipt;
      } catch (requestError) {
        if (scopeKeyRef.current === capturedKey) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Queued input could not be updated.",
          );
        }
        return null;
      }
    },
    [refresh, scopeKey],
  );

  const update = useCallback(
    (itemId: string, expectedVersion: number, text: string) => {
      if (!scope) return Promise.resolve(null);
      return runMutation(() =>
        client.updateThreadInput({
          operation: "thread.input.update",
          threadId: ThreadIdSchema.parse(scope.threadId),
          workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
          itemId,
          expectedVersion,
          content: { text },
        }),
      );
    },
    [client, runMutation, scope],
  );

  const remove = useCallback(
    (itemId: string, expectedVersion: number) => {
      if (!scope) return Promise.resolve(null);
      return runMutation(() =>
        client.removeThreadInput({
          operation: "thread.input.remove",
          threadId: ThreadIdSchema.parse(scope.threadId),
          workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
          itemId,
          expectedVersion,
        }),
      );
    },
    [client, runMutation, scope],
  );

  const steer = useCallback(
    (itemId: string, expectedVersion: number) => {
      if (!scope || !activeTarget) return Promise.resolve(null);
      return runMutation(() =>
        client.steerQueuedThreadInput({
          operation: "thread.input.steer",
          threadId: ThreadIdSchema.parse(scope.threadId),
          workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
          itemId,
          expectedVersion,
          expectedTurnId: TurnIdSchema.parse(activeTarget.turnId),
          expectedRunAttemptId: RunAttemptIdSchema.parse(
            activeTarget.runAttemptId,
          ),
        }),
      );
    },
    [activeTarget, client, runMutation, scope],
  );

  const start = useCallback(
    (
      itemId: string,
      expectedVersion: number,
      expectedThreadRevision: number,
    ) => {
      if (!scope) return Promise.resolve(null);
      return runMutation(() =>
        client.startQueuedThreadInput({
          operation: "thread.input.start",
          threadId: ThreadIdSchema.parse(scope.threadId),
          workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
          itemId,
          expectedVersion,
          expectedThreadRevision,
        }),
      );
    },
    [client, runMutation, scope],
  );

  return { snapshot, error, refresh, update, remove, steer, start };
}
