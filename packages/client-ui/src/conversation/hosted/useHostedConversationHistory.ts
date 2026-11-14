import { useEffect, useRef, useState } from "react";
import {
  buildConversationTurns,
  ConversationScopeHttpError,
  projectConversationHistoryMessages,
  readConversationHistory,
  RunIdSchema,
  replayConversationLifecycleProjection,
  TurnIdSchema,
  type ConversationScope,
  type LifecycleProjection,
} from "@legioncode/sdk";
import type { Message } from "@ai-sdk/react";
import type { HostedSessionWorkspaceContext } from "@repo/platform-protocol";
import { convertConversationHistoryMessages } from "../history/conversationHistoryMessages.js";
import {
  assertHostedWorkspace,
  hostedConversationScope,
  hostedLifecycleClient,
  type HostedConversationIdentity,
} from "./hostedNativeConversation.js";

interface HistoryState {
  readonly identity: HostedConversationIdentity;
  readonly revision: number;
  readonly messages: Message[];
  readonly context: HostedSessionWorkspaceContext | null;
  readonly scope: ConversationScope | null;
  readonly projections: Record<string, LifecycleProjection>;
  readonly ready: boolean;
  readonly error: string | null;
  readonly replayError: string | null;
  readonly scopeRecoveryError: ConversationScopeHttpError | null;
}

/** Saved transcript/scope reads only. Reconnect never reserves or submits a turn. */
export function useHostedConversationHistory(identity: HostedConversationIdentity) {
  const current = useRef(identity);
  current.current = identity;
  const [revision, setRevision] = useState(0);
  const requestedRevision = useRef(0);
  const [state, setState] = useState<HistoryState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const active = () => !controller.signal.aborted && current.current === identity && requestedRevision.current === revision;
    if (!identity.enabled) return () => controller.abort();
    setState({ identity, revision, messages: [], context: null, scope: null, projections: {}, ready: false, error: null, replayError: null, scopeRecoveryError: null });
    void (async () => {
      const [history, context, restored] = await Promise.all([
        readConversationHistory((cursor, snapshot) => identity.client.getConversationHistoryPage({
          session: identity.sessionId, limit: 100,
          ...(cursor !== null ? { cursor } : {}),
          ...(snapshot !== null ? { snapshot } : {}),
        }), { signal: controller.signal }),
        identity.client.getSessionWorkspaceContext(identity.sessionId, identity.runId),
        identity.client.getTurnScope({ sessionId: identity.sessionId, runId: RunIdSchema.parse(identity.runId) })
          .then((scope) => ({ scope, error: null }))
          .catch((error: unknown) => {
            if (error instanceof ConversationScopeHttpError && error.status === 409 && error.code === "TURN_ADMISSION_RECOVERY_REQUIRED") {
              return { scope: null, error };
            }
            throw error;
          }),
      ]);
      if (!active()) return;
      assertHostedWorkspace(identity, context);
      const scope = restored.scope ? hostedConversationScope(identity, restored.scope, context) : null;
      const messages = convertConversationHistoryMessages(projectConversationHistoryMessages(history.messages));
      setState({ identity, revision, messages, context, scope, projections: {}, ready: true, error: null, replayError: null, scopeRecoveryError: restored.error });
      const turnIds = [...new Set(buildConversationTurns(messages).flatMap((turn) => {
        const parsed = TurnIdSchema.safeParse(turn.turnId);
        return parsed.success && parsed.data !== scope?.turnId ? [parsed.data] : [];
      }))];
      // Historical turns have one bounded replay each, never another live poller.
      for (let offset = 0; offset < turnIds.length; offset += 4) {
        if (!active()) return;
        await Promise.all(turnIds.slice(offset, offset + 4).map(async (turnId) => {
          try {
            const projection = await replayConversationLifecycleProjection({
              turnId, lifecycleClient: hostedLifecycleClient(identity.client), signal: controller.signal,
            });
            if (!active() || !projection) return;
            setState((previous) => previous?.identity === identity
              ? { ...previous, projections: { ...previous.projections, [turnId]: projection } } : previous);
          } catch (error) {
            if (!active()) return;
            setState((previous) => previous?.identity === identity
              ? { ...previous, replayError: error instanceof Error ? error.message : "Saved workflow could not be read." } : previous);
          }
        }));
      }
    })().catch((error: unknown) => {
      if (!active()) return;
      setState({ identity, revision, messages: [], context: null, scope: null, projections: {}, ready: false,
        error: error instanceof Error ? error.message : "Saved hosted conversation could not be read.", replayError: null, scopeRecoveryError: null });
    });
    return () => controller.abort();
  }, [identity, revision]);
  const visible = identity.enabled && state?.identity === identity && state.revision === requestedRevision.current ? state : null;
  return {
    messages: visible?.messages ?? [],
    workspaceContext: visible?.context ?? null,
    scope: visible?.scope ?? null,
    projections: visible?.projections ?? {},
    historyReady: visible?.ready === true,
    loading: identity.enabled && !visible?.ready && !visible?.error,
    historyError: identity.error ?? visible?.error ?? null,
    replayError: visible?.replayError ?? null,
    scopeRecoveryError: visible?.scopeRecoveryError ?? null,
    isReadable: () => current.current === identity && identity.enabled && state?.identity === identity &&
      state.ready && state.revision === requestedRevision.current,
    reload: () => {
      if (current.current !== identity || !identity.enabled) return;
      requestedRevision.current += 1;
      setRevision(requestedRevision.current);
    },
  };
}
