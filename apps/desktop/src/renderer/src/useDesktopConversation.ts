import {
  createAppServerLifecycleClient,
  followConversationLifecycleProjection,
  replayConversationLifecycleProjection,
  type AppServerClient,
  type ConversationLifecycleContinuationStatus,
  type LifecycleProjection,
} from "@legioncode/sdk";
import { EventIdempotencyKeySchema, type Thread, type TurnAdmission } from "@repo/platform-protocol";
import { useEffect, useMemo, useRef, useState } from "react";

/** Scoped SDK reads and command delivery; lifecycle truth stays in SDK replay. */
export function useDesktopConversation(client: AppServerClient, thread: Thread) {
  const lifecycleClient = useMemo(() => createAppServerLifecycleClient(client), [client]);
  const [admissions, setAdmissions] = useState<TurnAdmission[]>([]);
  const [projections, setProjections] = useState<Record<string, LifecycleProjection>>({});
  const [loading, setLoading] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [continuation, setContinuation] = useState<ConversationLifecycleContinuationStatus | "stopped" | null>(null);
  const [reload, setReload] = useState(0);
  const [retry, setRetry] = useState(0);
  const [delivering, setDelivering] = useState(false);
  const scope = useRef<AbortController | null>(null);
  const loadedScope = useRef({ client, workspaceId: thread.workspaceId, threadId: thread.id });
  const scopeMatches = loadedScope.current.client === client && loadedScope.current.workspaceId === thread.workspaceId && loadedScope.current.threadId === thread.id;
  const pendingRequest = useRef<{ prompt: string; clientRequestId: ReturnType<typeof EventIdempotencyKeySchema.parse> } | null>(null);
  const commandPending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    commandPending.current = false;
    setDelivering(false);
    setHistoryReady(false);
    setLoading(true);
    setError(null);
    setLiveError(null);
    if (!scopeMatches) {
      pendingRequest.current = null;
      setAdmissions([]);
      setProjections({});
      loadedScope.current = { client, workspaceId: thread.workspaceId, threadId: thread.id };
    }
    setContinuation(null);
    void (async () => {
      const history: TurnAdmission[] = [];
      let cursor = null;
      const cursors = new Set<string>();
      do {
        const page = await client.getThreadHistoryPage({
          workspaceId: thread.workspaceId, threadId: thread.id, afterCursor: cursor, limit: 100,
        });
        if (controller.signal.aborted) return;
        for (const admission of page.admissions) {
          assertScope(admission, thread);
          history.push(admission);
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("History cursor did not advance");
        if (cursor) cursors.add(cursor);
      } while (cursor !== null);
      const latest = history.at(-1);
      if (latest) {
        const restored = await client.getTurn(latest.turn.id);
        assertScope(restored, thread);
        if (restored.turn.id !== latest.turn.id || restored.run.id !== latest.run.id || restored.runAttemptId !== latest.runAttemptId) {
          throw new Error("Restored turn identity changed");
        }
        history[history.length - 1] = restored;
      }
      const saved = await Promise.all(history.map(async (admission) => ({
        turnId: admission.turn.id,
        projection: await replayConversationLifecycleProjection({
          turnId: admission.turn.id, lifecycleClient, signal: controller.signal,
        }),
      })));
      if (controller.signal.aborted) return;
      setProjections(Object.fromEntries(saved.flatMap(({ turnId, projection }) => projection ? [[turnId, projection]] : [])));
      if (history.some((item) => item.clientRequestId === pendingRequest.current?.clientRequestId)) {
        pendingRequest.current = null;
      }
      setAdmissions(history);
      commandPending.current = saved.some(({ projection }) => !projection?.terminal);
      setHistoryReady(true);
      setLoading(false);
    })().catch(() => {
      if (controller.signal.aborted) return;
      setError("Saved local conversation could not be loaded. Retry before sending another prompt.");
      setLoading(false);
    });
    return () => { controller.abort(); };
  }, [client, lifecycleClient, thread.id, thread.workspaceId, reload]);

  const latest = admissions.at(-1) ?? null;
  useEffect(() => {
    if (!latest || loading) return;
    const controller = new AbortController();
    void followConversationLifecycleProjection({
      turnId: latest.turn.id, lifecycleClient, signal: controller.signal,
      onProjection: (projection) => {
        if (controller.signal.aborted) return;
        setLiveError(null);
        if (projection.terminal) commandPending.current = false;
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
  }, [latest?.turn.id, lifecycleClient, loading, retry]);

  const unsettled = admissions.some((admission) => !projections[admission.turn.id]?.terminal);

  async function submit(prompt: string): Promise<boolean> {
    const controller = scope.current;
    if (!scopeMatches || !controller || controller.signal.aborted || commandPending.current || !historyReady || loading || unsettled) return false;
    if (pendingRequest.current && pendingRequest.current.prompt !== prompt) {
      setError("The previous prompt is unconfirmed. Retry its unchanged draft or reload saved history first.");
      return false;
    }
    const request = pendingRequest.current ?? {
      prompt, clientRequestId: EventIdempotencyKeySchema.parse(crypto.randomUUID()),
    };
    pendingRequest.current = request;
    commandPending.current = true;
    setDelivering(true);
    setError(null);
    let accepted = false;
    try {
      const admission = await client.startTurn({
        workspaceId: thread.workspaceId, threadId: thread.id, ...request,
      });
      if (controller.signal.aborted || scope.current !== controller) return false;
      assertScope(admission, thread);
      if (admission.clientRequestId !== request.clientRequestId) throw new Error("Admission request changed");
      setAdmissions((current) => current.some((item) => item.turn.id === admission.turn.id) ? current : [...current, admission]);
      pendingRequest.current = null;
      accepted = !projections[admission.turn.id]?.terminal;
      return true;
    } catch {
      if (!controller.signal.aborted && scope.current === controller) {
        setError("Prompt delivery is unconfirmed. Retry the unchanged draft using the same request identity, or reload saved history.");
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
    if (!scopeMatches || !latest || projections[latest.turn.id]?.terminal) return;
    await client.interruptLocalTurn({
      workspaceId: latest.run.workspaceId, threadId: latest.turn.threadId,
      runId: latest.run.id, turnId: latest.turn.id, runAttemptId: latest.runAttemptId,
      reason: "User stopped the local turn.",
    });
    // The response is command delivery only; the follower supplies settlement.
  }

  return {
    admissions: scopeMatches ? admissions : [],
    projections: scopeMatches ? projections : {},
    loading: loading || !scopeMatches, error: scopeMatches ? error ?? liveError : null, continuation: scopeMatches ? continuation : null,
    busy: !scopeMatches || !historyReady || loading || delivering || unsettled,
    submit, stop,
    canStop: Boolean(scopeMatches && latest && !projections[latest.turn.id]?.terminal),
    retry: () => { setLiveError(null); setRetry((value) => value + 1); },
    reload: () => setReload((value) => value + 1),
  };
}

function assertScope(admission: TurnAdmission, thread: Thread): void {
  if (admission.run.workspaceId !== thread.workspaceId || admission.run.threadId !== thread.id || admission.turn.threadId !== thread.id) {
    throw new Error("Local admission does not belong to the selected thread");
  }
}
