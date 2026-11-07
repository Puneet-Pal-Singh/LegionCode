import {
  AppServerClientError,
  createAppServerLifecycleClient,
  LocalTurnStartParamsSchema,
  LocalTurnConfigurationSchema,
  type LocalTurnConfiguration,
  followConversationLifecycleProjection,
  replayConversationLifecycleProjection,
  type AppServerClient,
  type ConversationLifecycleContinuationStatus,
  type LifecycleProjection,
  type LocalTurnStartParams,
} from "@legioncode/sdk";
import type { EventCursor, Thread, TurnAdmission } from "@repo/platform-protocol";
import { useEffect, useMemo, useRef, useState } from "react";

const HISTORY_PAGE_SIZE = 25;
const REPLAY_CONCURRENCY = 2;

/** Scoped SDK reads and command delivery; lifecycle truth stays in SDK replay. */
export function useDesktopConversation(client: AppServerClient, thread: Thread, enabled: boolean) {
  const lifecycleClient = useMemo(() => createAppServerLifecycleClient(client), [client]);
  const [admissions, setAdmissions] = useState<TurnAdmission[]>([]);
  const [projections, setProjections] = useState<Record<string, LifecycleProjection>>({});
  const [loading, setLoading] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [continuation, setContinuation] = useState<ConversationLifecycleContinuationStatus | "stopped" | null>(null);
  const [reload, setReload] = useState(0);
  const [afterCursor, setAfterCursor] = useState<EventCursor | null>(null);
  const [latestPage, setLatestPage] = useState(true);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [nextCursor, setNextCursor] = useState<EventCursor | null>(null);
  const [retry, setRetry] = useState(0);
  const [delivering, setDelivering] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const stopCommand = useRef<Promise<void> | null>(null);
  const scope = useRef<AbortController | null>(null);
  const loadedScope = useRef({ client, workspaceId: thread.workspaceId, threadId: thread.id });
  const scopeMatches = loadedScope.current.client === client && loadedScope.current.workspaceId === thread.workspaceId && loadedScope.current.threadId === thread.id;
  const pendingRequest = useRef<LocalTurnStartParams | null>(null);
  const commandPending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    commandPending.current = false;
    setDelivering(false);
    setInterrupting(false);
    stopCommand.current = null;
    setHistoryReady(false);
    setLoading(enabled);
    setError(null);
    setLiveError(null);
    if (!scopeMatches) {
      pendingRequest.current = null;
      setAdmissions([]);
      setProjections({});
      setAfterCursor(null);
      setLatestPage(true);
      setHasEarlier(false);
      setNextCursor(null);
      loadedScope.current = { client, workspaceId: thread.workspaceId, threadId: thread.id };
    }
    setContinuation(null);
    if (!scopeMatches && (afterCursor !== null || !latestPage)) return () => { controller.abort(); };
    if (!enabled) {
      setAdmissions([]);
      setProjections({});
      return () => { controller.abort(); };
    }
    void (async () => {
      const page = await client.getThreadHistoryPage({
        workspaceId: thread.workspaceId, threadId: thread.id,
        afterCursor, limit: HISTORY_PAGE_SIZE,
        ...(latestPage ? { latest: true } : {}),
      });
      if (controller.signal.aborted) return;
      if (page.admissions.length > HISTORY_PAGE_SIZE || (page.nextCursor && page.nextCursor === afterCursor)) {
        throw new Error("Invalid history page");
      }
      const history = [...page.admissions];
      for (const admission of history) assertScope(admission, thread);
      // Existing cursors name the last returned record, even on the last page.
      // A one-record lookahead distinguishes the tail without retaining another page.
      const lookahead = page.nextCursor ? await client.getThreadHistoryPage({
        workspaceId: thread.workspaceId, threadId: thread.id,
        afterCursor: page.nextCursor, limit: 1,
      }) : null;
      if (controller.signal.aborted) return;
      const followingCursor = lookahead?.admissions.length ? page.nextCursor : null;
      const latest = history.at(-1);
      if (latest) {
        const restored = await client.getTurn(latest.turn.id);
        assertScope(restored, thread);
        if (restored.turn.id !== latest.turn.id || restored.run.id !== latest.run.id || restored.runAttemptId !== latest.runAttemptId) {
          throw new Error("Restored turn identity changed");
        }
        history[history.length - 1] = restored;
      }
      const saved: Record<string, LifecycleProjection> = {};
      for (let offset = 0; offset < history.length; offset += REPLAY_CONCURRENCY) {
        if (controller.signal.aborted) return;
        await Promise.all(history.slice(offset, offset + REPLAY_CONCURRENCY).map(async (admission) => {
          const projection = await replayConversationLifecycleProjection({
            turnId: admission.turn.id, lifecycleClient, signal: controller.signal,
          });
          if (projection) saved[admission.turn.id] = projection;
        }));
      }
      if (controller.signal.aborted) return;
      setProjections(saved);
      setNextCursor(followingCursor);
      setHasEarlier(latestPage && page.hasEarlier === true);
      if (history.some((item) => item.clientRequestId === pendingRequest.current?.clientRequestId)) {
        pendingRequest.current = null;
      }
      setAdmissions(history);
      commandPending.current = history.some((item) => !saved[item.turn.id]?.terminal);
      setHistoryReady(true);
      setLoading(false);
    })().catch(() => {
      if (controller.signal.aborted) return;
      setError("Saved local conversation could not be loaded. Retry before sending another prompt.");
      setLoading(false);
    });
    return () => { controller.abort(); };
  }, [client, lifecycleClient, thread.id, thread.workspaceId, reload, afterCursor, latestPage, enabled]);

  const latest = admissions.at(-1) ?? null;
  useEffect(() => {
    if (!enabled || !latest || loading || nextCursor !== null) return;
    const controller = new AbortController();
    void followConversationLifecycleProjection({
      turnId: latest.turn.id, lifecycleClient, signal: controller.signal,
      onProjection: (projection) => {
        if (controller.signal.aborted) return;
        setLiveError(null);
        if (projection.terminal) {
          commandPending.current = false;
          stopCommand.current = null;
          setInterrupting(false);
        }
        setProjections((current) => ({ ...current, [latest.turn.id]: projection }));
      },
      onStatus: (status) => {
        if (!controller.signal.aborted) setContinuation(status);
      },
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLiveError("Live updates stopped. The runtime outcome is unconfirmed; retry to read its status.");
      setContinuation("stopped");
    });
    return () => { controller.abort(); };
  }, [latest?.turn.id, lifecycleClient, loading, retry, nextCursor, enabled]);

  const unsettled = admissions.some((admission) => !projections[admission.turn.id]?.terminal);

  async function submit(
    prompt: string,
    configuration: LocalTurnConfiguration,
    expectedSelection: NonNullable<Awaited<ReturnType<AppServerClient["getProviderSelection"]>>>,
    images?: LocalTurnStartParams["images"],
  ): Promise<boolean> {
    const controller = scope.current;
    if (
      !enabled ||
      !scopeMatches ||
      !controller ||
      controller.signal.aborted ||
      commandPending.current ||
      !historyReady ||
      loading ||
      nextCursor !== null ||
      unsettled
    )
      return false;
    const retryingUnconfirmedRequest = pendingRequest.current !== null;
    // Local contract rejection must never claim a delivery identity or alter
    // conversation errors. Post-dispatch failures below remain unconfirmed.
    const params = LocalTurnStartParamsSchema.safeParse(
      {
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        prompt,
        clientRequestId: pendingRequest.current?.clientRequestId ?? crypto.randomUUID(),
        ...configuration,
        expectedSelection,
        ...(images?.length ? { images } : {}),
      },
    );
    if (!params.success) {
      throw new Error(
        params.error.issues[0]?.message ?? "Update the prompt before sending.",
      );
    }
    if (
      pendingRequest.current &&
      (pendingRequest.current.prompt !== params.data.prompt ||
        JSON.stringify(pendingRequest.current.images ?? []) !==
          JSON.stringify(params.data.images ?? []))
    ) {
      setError(
        "The previous prompt is unconfirmed. Retry its unchanged draft or reload saved history first.",
      );
      return false;
    }
    const request = pendingRequest.current ?? params.data;
    pendingRequest.current = request;
    commandPending.current = true;
    setDelivering(true);
    setError(null);
    let accepted = false;
    try {
      const admission = await client.startTurn(request);
      if (controller.signal.aborted || scope.current !== controller)
        return false;
      assertScope(admission, thread);
      if (admission.clientRequestId !== request.clientRequestId)
        throw new Error("Admission request changed");
      const visible = admissions.some(
        (item) => item.turn.id === admission.turn.id,
      )
        ? admissions
        : [...admissions, admission].slice(-HISTORY_PAGE_SIZE);
      const visibleIds = new Set<string>(visible.map((item) => item.turn.id));
      setAdmissions(visible);
      setProjections((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([turnId]) => visibleIds.has(turnId)),
        ),
      );
      pendingRequest.current = null;
      accepted = !projections[admission.turn.id]?.terminal;
      return true;
    } catch (error) {
      if (!controller.signal.aborted && scope.current === controller) {
        // This boundary rejection proves only the current attempt was not dispatched.
        // An earlier uncertain attempt can still have admitted the same identity.
        const operationCode =
          error instanceof AppServerClientError &&
          error.code === "server_error" &&
          error.serverError &&
          "operationCode" in error.serverError
            ? error.serverError.operationCode
            : null;
        const freshInputRejection =
          !retryingUnconfirmedRequest &&
          (operationCode === "local_provider_selection_changed" ||
            operationCode === "local_image_unavailable" ||
            operationCode === "local_image_validation_failed" ||
            operationCode === "local_image_model_unsupported");
        if (freshInputRejection) {
          if (pendingRequest.current?.clientRequestId === request.clientRequestId)
            pendingRequest.current = null;
          throw new Error(
            operationCode === "local_provider_selection_changed"
              ? "The selected model changed before delivery. Select your model again and retry your kept draft."
              : "The runtime could not accept these images. Check the attachments and selected model, then retry your kept draft.",
          );
        }
        if (
          !retryingUnconfirmedRequest &&
          error instanceof AppServerClientError &&
          error.code === "server_error" &&
          error.serverCode === "protocol_incompatible"
        ) {
          if (
            pendingRequest.current?.clientRequestId === request.clientRequestId
          ) {
            pendingRequest.current = null;
            throw new Error(
              "The local runtime needs a compatible Desktop connection. Copy your draft and restart Desktop before retrying.",
            );
          }
        }
        setError(
          "Prompt delivery is unconfirmed. Retry the unchanged draft using the same request identity, or reload saved history.",
        );
      }
      return false;
    } finally {
      if (scope.current === controller) {
        commandPending.current = accepted;
        setDelivering(false);
      }
    }
  }

  async function stop(): Promise<void> {
    const controller = scope.current;
    if (!enabled || !scopeMatches || !historyReady || loading || nextCursor !== null || !controller || controller.signal.aborted || !latest || projections[latest.turn.id]?.terminal) return;
    if (stopCommand.current) return stopCommand.current;
    setInterrupting(true);
    const request = client.interruptLocalTurn({
      workspaceId: latest.run.workspaceId, threadId: latest.turn.threadId,
      runId: latest.run.id, turnId: latest.turn.id, runAttemptId: latest.runAttemptId,
      reason: "User stopped the local turn.",
    }).then((receipt) => {
      if (controller.signal.aborted || scope.current !== controller) return;
      const terminal = receipt.terminalEvent;
      if (receipt.runId !== latest.run.id || (terminal && (
        terminal.threadId !== latest.turn.threadId || terminal.turnId !== latest.turn.id || terminal.runAttemptId !== latest.runAttemptId
      ))) throw new Error("Stop receipt belongs to another attempt");
      if (!receipt.accepted && receipt.status !== "settled") {
        throw new Error("The active runtime did not accept Stop");
      }
      // A receipt requests another canonical read; it never settles the projection.
      setRetry((value) => value + 1);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && scope.current === controller) {
        stopCommand.current = null;
        setInterrupting(false);
      }
      throw error;
    });
    stopCommand.current = request;
    return request;
  }

  return {
    admissions: enabled && scopeMatches ? admissions : [],
    projections: enabled && scopeMatches ? projections : {},
    loading: enabled && (loading || !scopeMatches), error: enabled && scopeMatches ? error ?? liveError : null, continuation: enabled && scopeMatches ? continuation : null,
    busy: enabled && (!scopeMatches || !historyReady || loading || nextCursor !== null || delivering || unsettled),
    nextPage: enabled && nextCursor && historyReady && !loading ? () => { setLatestPage(false); setAfterCursor(nextCursor); } : null,
    firstPage: enabled && (afterCursor !== null || (latestPage && hasEarlier)) ? () => { setLatestPage(false); setAfterCursor(null); } : null,
    hasNewerPages: enabled && nextCursor !== null,
    pendingSelection: pendingRequest.current?.expectedSelection ?? null,
    pendingConfiguration: pendingRequest.current
      ? LocalTurnConfigurationSchema.parse({
          mode: pendingRequest.current.mode,
          productMode: pendingRequest.current.productMode,
        })
      : null,
    submit, stop, interrupting: scopeMatches && interrupting,
    canStop: Boolean(enabled && scopeMatches && historyReady && !loading && nextCursor === null && !interrupting && latest && !projections[latest.turn.id]?.terminal),
    retry: () => { setLiveError(null); setRetry((value) => value + 1); },
    reload: () => { setLatestPage(true); setAfterCursor(null); setReload((value) => value + 1); },
  };
}

function assertScope(admission: TurnAdmission, thread: Thread): void {
  if (admission.run.workspaceId !== thread.workspaceId || admission.run.threadId !== thread.id || admission.turn.threadId !== thread.id || admission.turn.runId !== admission.run.id) {
    throw new Error("Local admission does not belong to the selected thread");
  }
}
