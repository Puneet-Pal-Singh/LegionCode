import {
  AppServerClientError,
  createAppServerLifecycleClient,
  LocalTurnStartParamsSchema,
  LocalTurnConfigurationSchema,
  type LocalTurnConfiguration,
  mergeLifecycleProjections,
  replayConversationLifecycleProjection,
  type AppServerClient,
  type LifecycleProjection,
  type LocalTurnStartParams,
  type LocalThreadHistoryMessagesContinuation,
} from "@legioncode/sdk";
import { useConversationTurnLifecycle } from "@legioncode/client-ui";
import type { EventCursor, Thread, TurnAdmission } from "@repo/platform-protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import { readDesktopHistoryWindow, assertDesktopAdmissionScope as assertScope, type DesktopHistoryWindow, DESKTOP_HISTORY_PAGE_SIZE as HISTORY_PAGE_SIZE } from "./desktop-conversation-history";
const REPLAY_CONCURRENCY = 2;

/** Scoped SDK reads and command delivery; lifecycle truth stays in SDK replay. */
export function useDesktopConversation(
  client: AppServerClient,
  thread: Thread,
  enabled: boolean,
  onAdmissionConfirmed?: (admission: TurnAdmission) => void,
) {
  const admissionConfirmed = useRef(onAdmissionConfirmed);
  admissionConfirmed.current = onAdmissionConfirmed;
  const lifecycleClient = useMemo(() => createAppServerLifecycleClient(client), [client]);
  const [admissions, setAdmissions] = useState<TurnAdmission[]>([]);
  const [body, setBody] = useState<Pick<DesktopHistoryWindow, "messages" | "window">>({ messages: [], window: null });
  const [messagesContinuation, setMessagesContinuation] = useState<LocalThreadHistoryMessagesContinuation | null>(null);
  const [navigation, setNavigation] = useState({ key: 0, intent: "latest" as "earlier" | "newer" | "latest" });
  const [completedNavigation, setCompletedNavigation] = useState(navigation);
  const inputReadSequence = useRef({ turnId: "", sequence: 0 });
  const [replayedProjections, setProjections] = useState<Record<string, LifecycleProjection>>({});
  const [loading, setLoading] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [initialReadSettled, setInitialReadSettled] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [deliveryError, setError] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [afterCursor, setAfterCursor] = useState<EventCursor | null>(null);
  const [latestPage, setLatestPage] = useState(true);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [nextCursor, setNextCursor] = useState<EventCursor | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const stopCommand = useRef<Promise<void> | null>(null);
  const scope = useRef<AbortController | null>(null);
  const loadedScope = useRef({ client, workspaceId: thread.workspaceId, threadId: thread.id });
  const scopeMatches = loadedScope.current.client === client && loadedScope.current.workspaceId === thread.workspaceId && loadedScope.current.threadId === thread.id;
  const pendingRequest = useRef<LocalTurnStartParams | null>(null);
  const commandPending = useRef(false);
  const admittedDelivery = useRef<{
    client: AppServerClient;
    workspaceId: Thread["workspaceId"];
    threadId: Thread["id"];
    turnId: TurnAdmission["turn"]["id"];
  } | null>(null);
  // Each handler belongs to the read/admission snapshot that rendered it. An
  // accepted command invalidates that snapshot synchronously, before React can
  // commit admissions; only a newly rendered handler may send again.
  const renderedReadScope = scope.current;
  const renderedAdmission = admittedDelivery.current;

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    commandPending.current = false;
    setDelivering(false);
    setInterrupting(false);
    stopCommand.current = null;
    setHistoryReady(false);
    setLoading(enabled);
    setHistoryError(null);
    setReplayError(null);
    if (!scopeMatches) {
      setInitialReadSettled(false);
      setError(null);
      admittedDelivery.current = null;
      pendingRequest.current = null;
      setAdmissions([]);
      setBody({ messages: [], window: null });
      setMessagesContinuation(null);
      setProjections({});
      setAfterCursor(null);
      setLatestPage(true);
      setHasEarlier(false);
      setNextCursor(null);
      loadedScope.current = { client, workspaceId: thread.workspaceId, threadId: thread.id };
    }
    if (!scopeMatches && (afterCursor !== null || !latestPage || messagesContinuation !== null)) return () => { controller.abort(); };
    if (!enabled) {
      setInitialReadSettled(false);
      setAdmissions([]);
      setBody({ messages: [], window: null });
      setMessagesContinuation(null);
      setProjections({});
      return () => { controller.abort(); };
    }
    void (async () => {
      const page = await readDesktopHistoryWindow(client, thread, {
        workspaceId: thread.workspaceId, threadId: thread.id,
        ...(messagesContinuation ? { messagesContinuation, messageLimit: 100 } : {
          afterCursor, limit: HISTORY_PAGE_SIZE, messageLimit: 100,
          ...(latestPage ? { latest: true } : {}),
        }),
      }, { admissions, ...body, nextCursor, hasEarlier }, controller.signal);
      if (controller.signal.aborted || scope.current !== controller) return;
      const history = page.admissions;
      setNextCursor(page.nextCursor);
      setHasEarlier(page.hasEarlier);
      setBody({ messages: page.messages, window: page.window });
      setCompletedNavigation(navigation);
      if (history.some((item) => item.clientRequestId === pendingRequest.current?.clientRequestId)) {
        pendingRequest.current = null;
        setError(null);
      }
      const visibleTurnIds = new Set<string>(history.map((item) => item.turn.id));
      // Retain valid snapshots for this page only. The shared live adapter adds
      // its exact currently selected turn separately, without retaining pages.
      setProjections((current) => Object.fromEntries(
        Object.entries(current).filter(([turnId]) => visibleTurnIds.has(turnId)),
      ));
      setAdmissions(history);
      setHistoryReady(true);
      setInitialReadSettled(true);
      setLoading(false);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setHistoryError(error instanceof Error ? error.message : "Saved local conversation could not be loaded.");
      setInitialReadSettled(true);
      setLoading(false);
    });
    return () => { controller.abort(); };
  }, [client, lifecycleClient, thread.id, thread.workspaceId, reload, afterCursor, latestPage, messagesContinuation, navigation.key, enabled]);

  const latest = enabled && scopeMatches ? admissions.at(-1) ?? null : null;
  const followsLatest = Boolean(enabled && scopeMatches && latestPage && nextCursor === null && !body.window?.hasLater);
  const active = useConversationTurnLifecycle(latest?.turn.id, followsLatest, lifecycleClient);
  const activeProjection = followsLatest && active.isReplayReady ? active.projection : null;
  const projections = useMemo(
    () => mergeLifecycleProjections(replayedProjections, {}, activeProjection),
    [replayedProjections, activeProjection],
  );
  const executionActive = Boolean(activeProjection && activeProjection.lastSequence > 0 && !activeProjection.terminal);
  const awaitingActiveReplay = Boolean(followsLatest && latest && !active.isReplayReady);

  // Historical projections are independent reads: an old failure cannot prevent
  // the selected attempt's SDK replay/live continuation from rendering.
  useEffect(() => {
    if (!enabled || !scopeMatches) return;
    const controller = new AbortController();
    const history = admissions.filter((item) => !followsLatest || item.turn.id !== latest?.turn.id);
    setReplayError(null);
    void (async () => {
      for (let offset = 0; offset < history.length; offset += REPLAY_CONCURRENCY) {
        if (controller.signal.aborted) return;
        await Promise.all(history.slice(offset, offset + REPLAY_CONCURRENCY).map(async (admission) => {
          try {
            const projection = await replayConversationLifecycleProjection({
              turnId: admission.turn.id, lifecycleClient, signal: controller.signal,
            });
            if (controller.signal.aborted || !projection) return;
            setProjections((current) => mergeLifecycleProjections(current, {}, projection));
          } catch (error: unknown) {
            if (controller.signal.aborted) return;
            setReplayError(error instanceof Error ? error.message : "An earlier turn's lifecycle could not be loaded.");
          }
        }));
      }
    })();
    return () => controller.abort();
  }, [admissions, enabled, scopeMatches, followsLatest, latest?.turn.id, lifecycleClient]);

  useEffect(() => {
    if (!activeProjection) return;
    setProjections((current) => mergeLifecycleProjections(current, {}, activeProjection));
    if (!activeProjection.terminal) return;
    stopCommand.current = null;
    setInterrupting(false);
  }, [activeProjection]);

  useEffect(() => {
    const sequence = activeProjection?.inputSequence ?? 0;
    if (!activeProjection || !followsLatest || loading || delivering || interrupting || !historyReady) return;
    const previous = inputReadSequence.current;
    if (previous.turnId === activeProjection.turnId && sequence <= previous.sequence) return;
    inputReadSequence.current = { turnId: activeProjection.turnId, sequence };
    if (sequence === 0) return;
    // Invalidate this read owner from canonical accepted/applied facts; their
    // acknowledgement contains no transcript body and never supplies a row.
    setMessagesContinuation(null);
    setReload((value) => value + 1);
  }, [activeProjection?.turnId, activeProjection?.inputSequence, followsLatest, loading, delivering, interrupting, historyReady]);

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
      controller !== renderedReadScope ||
      controller.signal.aborted ||
      admittedDelivery.current !== renderedAdmission ||
      loadedScope.current.client !== client ||
      loadedScope.current.workspaceId !== thread.workspaceId ||
      loadedScope.current.threadId !== thread.id ||
      commandPending.current ||
      !historyReady ||
      loading ||
      nextCursor !== null ||
      !latestPage ||
      body.window?.hasLater ||
      (latest !== null && (!activeProjection || !activeProjection.terminal))
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
    try {
      const admission = await client.startTurn(request);
      if (controller.signal.aborted || scope.current !== controller)
        return false;
      assertScope(admission, thread);
      if (admission.clientRequestId !== request.clientRequestId)
        throw new Error("Admission request changed");
      admittedDelivery.current = {
        client, workspaceId: thread.workspaceId, threadId: thread.id,
        turnId: admission.turn.id,
      };
      setHistoryReady(false);
      setMessagesContinuation(null);
      setLatestPage(true);
      setAfterCursor(null);
      setNavigation((value) => ({ key: value.key + 1, intent: "latest" }));
      setReload((value) => value + 1);
      pendingRequest.current = null;
      try {
        admissionConfirmed.current?.(admission);
      } catch {
        // A metadata refresh is read-only follow-up to an already-confirmed
        // admission. It must never retain/resend this successfully sent draft.
        console.warn("Confirmed Thread metadata refresh could not be started");
      }
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
            operationCode === "local_model_unavailable" ||
            operationCode === "local_provider_discovery_unavailable" ||
            operationCode === "local_image_unavailable" ||
            operationCode === "local_image_validation_failed" ||
            operationCode === "local_image_model_unsupported");
        if (freshInputRejection) {
          if (pendingRequest.current?.clientRequestId === request.clientRequestId)
            pendingRequest.current = null;
          throw new Error(
            operationCode === "local_provider_selection_changed"
              ? "The selected model changed before delivery. Select your model again and retry your kept draft."
              : operationCode === "local_model_unavailable" || operationCode === "local_provider_discovery_unavailable"
              ? "The selected model is unavailable. Open provider setup, choose an available model, then retry your kept draft."
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
        commandPending.current = false;
        setDelivering(false);
      }
    }
  }

  async function stop(): Promise<void> {
    const controller = scope.current;
    if (!enabled || !scopeMatches || !historyReady || loading || !latestPage || nextCursor !== null || body.window?.hasLater || !executionActive || !controller || controller.signal.aborted || !latest || projections[latest.turn.id]?.terminal) return;
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
      active.retry();
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

  const scopeReadable = enabled && scopeMatches;
  const historyLoading = enabled && (loading || !scopeMatches);
  const submissionUnavailableReason = !scopeReadable || historyLoading
    ? "Loading saved conversation before sending."
    : historyError
      ? "Reload saved history before sending another message."
      : !historyReady
        ? "Read saved conversation before sending another message."
        : delivering
          ? "Confirming message delivery…"
          : nextCursor !== null || !latestPage || body.window?.hasLater
            ? "Return to the latest turns before sending another message."
            : awaitingActiveReplay || (latest && !activeProjection)
              ? "Read the admitted turn's runtime status before sending another message."
              : activeProjection && !activeProjection.terminal && !executionActive
                ? "Waiting for the admitted turn's canonical runtime status."
                : undefined;

  return {
    admissions: scopeReadable ? admissions : [],
    messages: scopeReadable ? body.messages : [],
    messagesWindow: scopeReadable ? body.window : null,
    historyNavigation: { key: String(completedNavigation.key), intent: completedNavigation.intent },
    projections: scopeReadable ? projections : {},
    loading: historyLoading,
    initialLoading: historyLoading && (!initialReadSettled || !scopeMatches),
    historyReady: scopeReadable && historyReady,
    historyError: scopeReadable ? historyError : null,
    deliveryError: scopeReadable ? deliveryError : null,
    historicalReplayError: scopeReadable ? replayError : null,
    continuationError: scopeReadable ? active.error : null,
    continuation: scopeReadable ? active.continuationStatus : null,
    activeProjection: scopeReadable ? activeProjection : null,
    awaitingActiveReplay: scopeReadable && awaitingActiveReplay && active.continuationStatus !== "stopped",
    deliveryPending: scopeReadable && delivering,
    executionActive: scopeReadable && executionActive,
    submissionUnavailableReason,
    nextPage: enabled && historyReady && !loading && (body.window?.hasLater || nextCursor) ? () => {
      setNavigation((value) => ({ key: value.key + 1, intent: "newer" }));
      if (body.window?.hasLater) {
        setMessagesContinuation({ turnIds: body.window.turnIds, throughCursor: body.window.throughCursor,
          direction: "forward", cursor: body.window.lastCursor });
      } else { setMessagesContinuation(null); setLatestPage(false); setAfterCursor(nextCursor); }
    } : null,
    firstPage: enabled && historyReady && !loading && (body.window?.hasEarlier || afterCursor !== null || (latestPage && hasEarlier)) ? () => {
      setNavigation((value) => ({ key: value.key + 1, intent: "earlier" }));
      if (body.window?.hasEarlier) {
        setMessagesContinuation({ turnIds: body.window.turnIds, throughCursor: body.window.throughCursor,
          direction: "backward", cursor: body.window.firstCursor });
      } else { setMessagesContinuation(null); setLatestPage(false); setAfterCursor(null); }
    } : null,
    hasNewerPages: enabled && (nextCursor !== null || !latestPage || body.window?.hasLater === true),
    pendingSelection: pendingRequest.current?.expectedSelection ?? null,
    pendingConfiguration: pendingRequest.current
      ? LocalTurnConfigurationSchema.parse({
          mode: pendingRequest.current.mode,
          productMode: pendingRequest.current.productMode,
        })
      : null,
    submit, stop, interrupting: scopeMatches && interrupting,
    canStop: Boolean(scopeReadable && historyReady && !loading && latestPage && nextCursor === null && !body.window?.hasLater && !interrupting && latest && executionActive),
    retry: active.retry,
    reload: () => { setMessagesContinuation(null); setLatestPage(true); setAfterCursor(null); setNavigation((value) => ({ key: value.key + 1, intent: "latest" })); setReload((value) => value + 1); },
  };
}
