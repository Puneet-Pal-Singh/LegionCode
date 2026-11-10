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
  type PlatformClient,
} from "@legioncode/sdk";

export type ThreadInputQueueClient = Pick<
  PlatformClient,
  "listThreadInputs" | "updateThreadInput" | "removeThreadInput" |
  "steerQueuedThreadInput" | "startQueuedThreadInput"
>;

/** Host read identity; local callers do not need a hosted Session or Run. */
export interface ThreadInputQueueScope {
  readonly key: string;
  readonly workspaceId: string;
  readonly threadId: string;
}

export interface ThreadInputQueueActiveTarget {
  readonly turnId: string;
  readonly runAttemptId: string;
}

type QueueBinding = {
  readonly scopeKey: string | null;
  readonly client: ThreadInputQueueClient;
};

export function useThreadInputQueue(
  scope: ThreadInputQueueScope | null,
  activeTarget: ThreadInputQueueActiveTarget | null,
  invalidationKey: string,
  client: ThreadInputQueueClient,
) {
  const scopeKey = scope?.key ?? null;
  const binding = useMemo<QueueBinding>(() => ({ scopeKey, client }), [scopeKey, client]);
  const [snapshotState, setSnapshotState] = useState<{
    binding: QueueBinding;
    value: ThreadInputQueueSnapshot;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    binding: QueueBinding;
    value: string;
  } | null>(null);
  const bindingRef = useRef<QueueBinding | null>(binding);
  const requestVersionRef = useRef(0);
  const snapshotRef = useRef<{
    binding: QueueBinding;
    value: ThreadInputQueueSnapshot;
  } | null>(null);

  const snapshot =
    snapshotState?.binding === binding ? snapshotState.value : null;
  const error = errorState?.binding === binding ? errorState.value : null;
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
    bindingRef.current = binding;
    requestVersionRef.current += 1;
    snapshotRef.current = null;
    return () => {
      if (bindingRef.current !== binding) return;
      bindingRef.current = null;
      requestVersionRef.current += 1;
    };
  }, [binding]);

  const refresh = useCallback(async () => {
    if (!scope || bindingRef.current !== binding) return null;
    const capturedBinding = binding;
    const requestVersion = ++requestVersionRef.current;
    try {
      const next = await client.listThreadInputs({
        operation: "thread.input.list",
        threadId: ThreadIdSchema.parse(scope.threadId),
        workspaceId: WorkspaceScopeIdSchema.parse(scope.workspaceId),
        ...(snapshotRef.current?.binding === capturedBinding
          ? { knownRevision: snapshotRef.current.value.revision }
          : {}),
      });
      if (
        bindingRef.current !== capturedBinding ||
        requestVersionRef.current !== requestVersion
      ) {
        return null;
      }
      const nextState = { binding: capturedBinding, value: next };
      setSnapshotState(nextState);
      snapshotRef.current = nextState;
      setErrorState(null);
      return next;
    } catch (requestError) {
      if (bindingRef.current === capturedBinding && requestVersionRef.current === requestVersion) {
        setErrorState({
          binding: capturedBinding,
          value:
            requestError instanceof Error
              ? requestError.message
              : "Queued inputs could not be loaded.",
        });
      }
      return null;
    }
  }, [binding, client, scope]);

  useEffect(() => {
    if (!scope) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
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
      if (!scope || bindingRef.current !== binding) return null;
      const capturedBinding = binding;
      try {
        const receipt = await action();
        if (bindingRef.current !== capturedBinding) return null;
        if (receipt.status === "conflict") {
          setErrorState({ binding: capturedBinding, value: receipt.message });
        } else {
          setErrorState(null);
        }
        await refresh();
        return bindingRef.current === capturedBinding ? receipt : null;
      } catch (requestError) {
        if (bindingRef.current === capturedBinding) {
          setErrorState({
            binding: capturedBinding,
            value:
              requestError instanceof Error
                ? requestError.message
                : "Queued input could not be updated.",
          });
        }
        return null;
      }
    },
    [binding, refresh, scope],
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
