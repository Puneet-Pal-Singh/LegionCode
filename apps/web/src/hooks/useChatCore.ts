import { useChat as useVercelChat, type Message } from "@ai-sdk/react";
import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from "@repo/platform-client-sdk";
import {
  DEFAULT_RUN_MODE,
  type ProductMode,
  type RunMode,
} from "@repo/shared-types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { chatStreamPath } from "../lib/platform-endpoints.js";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";
import { dispatchRunSummaryRefresh } from "../lib/run-summary-events.js";
import { useProviderStore } from "./useProviderStore.js";
import type { ChatDebugEvent } from "../types/chat-debug.js";
import {
  normalizeChatErrorMessage,
  pickDebugHeaders,
  shouldLogStreamError,
} from "../lib/chat-errors";
import {
  requireResolvedProviderConfig,
  resolveSelectedProviderConfig,
  type ResolvedProviderConfig,
} from "../lib/chat-provider-config";
import {
  parseChatRequestBody,
  resolveRuntimeHarnessId,
  type ChatRequestBody,
} from "../lib/chat-request";
import { resolveReasoningEffortForRequest } from "../lib/model-reasoning-preferences";
import { loadRepositoryContextFields } from "../lib/chat-repository-context";
import {
  toImageParts,
  toRedactedImageMetadata,
  type ChatImageAttachment,
} from "../components/chat/chatImageAttachments";
import { createRunId } from "../lib/run-id";
import {
  bootstrapConversationScope,
  conversationScopeKey,
  isEstablishedRunScope,
  isTurnScopeRecoveryError,
  publishConversationScopeReady,
  resumeConversationScope,
  type ConversationScope,
} from "./conversationScope";
import { createLifecycleClient } from "../services/api/lifecycleClient";
import { hasCanonicalLifecycleEvidence } from "./chat/resolveChatTransportFailure";
import {
  acquireSubmissionAttempt,
  finishSubmissionAttempt,
  retainSubmissionReservation,
  type SubmissionAttempt,
  type SubmissionOutcome,
} from "./chat/submissionAttemptRegistry";
import {
  createSubmissionObservedFetch,
  findAttemptForObservedResponse,
} from "./chat/submissionTransport";
import {
  useActiveTurnProjection,
  deriveCanonicalRunLoading,
  resolveActiveProjectionTurnId,
  type ActiveTurnProjection,
} from "./useActiveTurnProjection.js";

export type ChatUserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          image: string;
          mimeType: string;
          name: string;
        }
    >;

export interface ChatAppendMessage {
  id?: string;
  role: "user";
  content: ChatUserContent;
  imageMetadata?: ReturnType<typeof toRedactedImageMetadata>;
}

interface ChatSubmitAttachments {
  imageAttachments?: ChatImageAttachment[];
}

interface UseChatCoreResult {
  optimisticUserMessageId: string | null;
  input: string;
  handleInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (
    e?: FormEvent,
    attachments?: ChatSubmitAttachments,
  ) => Promise<boolean>;
  append: (message: ChatAppendMessage) => Promise<SubmissionOutcome>;
  optimisticUserMessage: Message | null;
  isLoading: boolean;
  stop: () => void;
  runId: string;
  scope: ConversationScope | null;
  serverTurnId: string | null;
  activeTurnProjection: ActiveTurnProjection;
  resetRun: () => void;
  isModelConfigReady: boolean;
  error: string | null;
  clearNonCanonicalError: () => void;
  debugEvents: ChatDebugEvent[];
  reviseTurn: (turnId: string, content: string) => Promise<boolean>;
}

/**
 * useChatCore
 * Minimal wrapper around Vercel AI SDK with UUID runId generation
 * Single Responsibility: Manage Vercel AI SDK integration and run lifecycle
 * Now includes provider/model selection from session state (reactive)
 */
export function useChatCore(
  sessionId: string,
  externalRunId?: string,
  mode: RunMode = DEFAULT_RUN_MODE,
  productMode?: ProductMode,
  onServerProjectionAvailable?: () => void,
): UseChatCoreResult {
  const [internalRunId, setInternalRunId] = useState<string>(() =>
    createRunId(),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [serverTurnId, setServerTurnId] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<{
    scopeKey: string;
    message: Message;
  } | null>(null);
  const [optimisticUserMessageId, setOptimisticUserMessageId] = useState<
    string | null
  >(null);
  const [debugEvents, setDebugEvents] = useState<ChatDebugEvent[]>([]);
  const preAdmissionStopKeyRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
  const activeSubmissionAttemptRef = useRef<SubmissionAttempt | null>(null);
  const retainedSubmissionScopeRef = useRef<ConversationScope | null>(null);
  const activeComposerSubmissionRef = useRef<string | null>(null);
  const latestComposerInputRef = useRef("");
  const lastLoggedStreamErrorRef = useRef<{
    message: string;
    timestamp: number;
  } | null>(null);
  const runId = externalRunId || internalRunId;
  const apiPath = chatStreamPath();
  const [conversationScope, setConversationScope] =
    useState<ConversationScope | null>(null);
  const clearNonCanonicalError = useCallback(() => setError(null), []);
  const activeConversationScope =
    conversationScope?.sessionId === sessionId &&
    (conversationScope.runId === runId ||
      activeSubmissionAttemptRef.current?.scope?.turnId ===
        conversationScope.turnId ||
      retainedSubmissionScopeRef.current?.turnId === conversationScope.turnId)
      ? conversationScope
      : null;
  const scopeKey = activeConversationScope
    ? conversationScopeKey(activeConversationScope)
    : null;
  const runScopeKey = `${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}`;
  const lastRenderedRunScopeKeyRef = useRef(runScopeKey);
  const runScopeGenerationRef = useRef(0);
  if (lastRenderedRunScopeKeyRef.current !== runScopeKey) {
    lastRenderedRunScopeKeyRef.current = runScopeKey;
    runScopeGenerationRef.current += 1;
  }
  const renderedScopeGeneration = runScopeGenerationRef.current;
  const activeScopeKeyRef = useRef(scopeKey);
  const activeRunScopeKeyRef = useRef(runScopeKey);
  const activeConversationScopeRef = useRef(activeConversationScope);
  const isActiveScope = useCallback(
    (candidateScopeKey: string | null) =>
      activeScopeKeyRef.current === candidateScopeKey,
    [],
  );
  const isActiveRunScope = useCallback(
    (candidateRunScopeKey: string) =>
      activeRunScopeKeyRef.current === candidateRunScopeKey,
    [],
  );
  const isActiveRunInvocation = useCallback(
    (candidateRunScopeKey: string, candidateGeneration: number) =>
      runScopeGenerationRef.current === candidateGeneration &&
      activeRunScopeKeyRef.current === candidateRunScopeKey,
    [],
  );

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    activeConversationScopeRef.current = activeConversationScope;
    setServerTurnId(activeConversationScope?.turnId ?? null);
    const presentationScopeKey = scopeKey ?? runScopeKey;
    setPendingUserMessage((current) =>
      current?.scopeKey === presentationScopeKey ? current : null,
    );
  }, [activeConversationScope, runScopeKey, scopeKey]);

  useEffect(() => {
    activeRunScopeKeyRef.current = runScopeKey;
    preAdmissionStopKeyRef.current = null;
    stopRequestedRef.current = false;
    setError(null);
    setIsSubmitting(false);
    setIsStopping(false);
    setOptimisticUserMessageId(null);
    setDebugEvents([]);
    lastLoggedStreamErrorRef.current = null;
  }, [runScopeKey]);

  useEffect(() => {
    const normalizedSessionId = sessionId.trim();
    const normalizedRunId = externalRunId?.trim() ?? "";
    if (!normalizedSessionId || !normalizedRunId) {
      setConversationScope(null);
      return;
    }
    const controller = new AbortController();
    const requestRunScopeKey = `${encodeURIComponent(normalizedSessionId)}:${encodeURIComponent(normalizedRunId)}`;
    void resumeConversationScope(
      normalizedSessionId,
      normalizedRunId,
      controller.signal,
    )
      .then((scope) => {
        if (
          controller.signal.aborted ||
          !isActiveRunScope(requestRunScopeKey)
        ) {
          return;
        }
        if (!scope) return;
        const nextScopeKey = conversationScopeKey(scope);
        activeScopeKeyRef.current = nextScopeKey;
        activeConversationScopeRef.current = scope;
        setConversationScope(scope);
        setError((current) =>
          isTurnScopeRecoveryError(current) ? null : current,
        );
        publishConversationScopeReady(scope);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          !isActiveRunScope(requestRunScopeKey)
        ) {
          return;
        }
        if (
          isEstablishedRunScope(
            activeConversationScopeRef.current,
            normalizedSessionId,
            normalizedRunId,
          )
        ) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
        logClientWarning("chat/scope", "reconstruction-failed", {
          runId: normalizedRunId,
          sessionId: normalizedSessionId,
          error: message,
        });
      });
    return () => controller.abort();
  }, [externalRunId, isActiveRunScope, runId, runScopeKey, sessionId]);

  const pushDebugEvent = useCallback(
    (event: Omit<ChatDebugEvent, "id" | "timestamp">) => {
      setDebugEvents((previous) =>
        [
          {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...event,
          },
          ...previous,
        ].slice(0, 50),
      );
    },
    [],
  );

  // Vercel owns the stream instance. Its identity must include every
  // transcript boundary, never only the run attempt.
  const instanceKey = runScopeKey;
  const {
    status,
    credentials,
    selectedProviderId,
    selectedCredentialId,
    selectedModelId,
    lastResolvedConfig,
    providerModels,
    manageProviderModels,
    resolveForChat,
  } = useProviderStore(runId);
  const selectedModel =
    selectedProviderId && selectedModelId
      ? (providerModels[selectedProviderId]?.find(
          (model) => model.id === selectedModelId,
        ) ??
        manageProviderModels[selectedProviderId]?.find(
          (model) => model.id === selectedModelId,
        ))
      : undefined;
  const selectedModelContextWindow = selectedModel?.contextWindow;
  const selectedModelPricing = selectedModel?.pricing;
  const selectedModelEfforts = selectedModel?.capabilities?.reasoningEfforts;
  const authenticatedChatFetch = useMemo(
    () => createSubmissionObservedFetch(fetchWithSessionAuth),
    [],
  );
  const hasConnectedCredential = credentials.length > 0;
  const isModelConfigReady = status === "ready" && hasConnectedCredential;
  const lifecycleClient = useMemo(() => createLifecycleClient(), []);

  const {
    input,
    handleInputChange,
    isLoading: isTransportLoading,
    stop: stopStream,
    append,
  } = useVercelChat({
    api: apiPath,
    streamProtocol: "text",
    body: {
      sessionId,
      runId,
      mode,
      productMode,
      ...(activeConversationScope
        ? {
            identity: {
              workspaceId: activeConversationScope.workspaceId,
              threadId: activeConversationScope.threadId,
              turnId: activeConversationScope.turnId,
              runAttemptId: activeConversationScope.runAttemptId,
              ...(activeConversationScope.revisionOfTurnId
                ? { revisionOfTurnId: activeConversationScope.revisionOfTurnId }
                : {}),
            },
          }
        : {}),
    },
    initialMessages: [],
    id: instanceKey,
    onResponse: (response: Response) => {
      const responseAttempt = findAttemptForObservedResponse(response);
      if (
        !responseAttempt ||
        responseAttempt !== activeSubmissionAttemptRef.current ||
        responseAttempt.runScopeGeneration !== renderedScopeGeneration ||
        !isActiveRunInvocation(runScopeKey, renderedScopeGeneration)
      ) {
        return;
      }
      const currentScope = activeConversationScopeRef.current;
      const responseTurnId = response.headers.get("X-Turn-Id")?.trim() ?? null;
      if (responseTurnId && responseTurnId !== currentScope?.turnId) {
        logClientWarning("chat/stream", "scope-mismatch", {
          runId,
          sessionId,
          expectedTurnId: currentScope?.turnId ?? null,
          responseTurnId,
        });
        return;
      }
      dispatchRunSummaryRefresh(runId);
      onServerProjectionAvailable?.();
      logClientEvent("chat/stream", "response", {
        runId,
        sessionId,
        turnId: currentScope?.turnId ?? null,
        status: response.status,
      });
      pushDebugEvent({
        phase: "response",
        summary: `HTTP ${response.status} ${response.statusText}`,
        payload: {
          status: response.status,
          statusText: response.statusText,
          headers: pickDebugHeaders(response.headers),
        },
      });
    },
    onFinish: (message, details) => {
      const attempt = activeSubmissionAttemptRef.current;
      if (
        !attempt ||
        attempt.runScopeGeneration !== renderedScopeGeneration ||
        !isActiveRunInvocation(runScopeKey, renderedScopeGeneration)
      ) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
      onServerProjectionAvailable?.();
      logClientEvent("chat/stream", "finished", {
        runId,
        sessionId,
        responseLength: message.content.length,
      });
      pushDebugEvent({
        phase: "finish",
        summary: "Stream finished",
        payload: {
          assistantMessage: message.content,
          finishDetails: details,
        },
      });
    },
    onError: (error: Error) => {
      const attempt = activeSubmissionAttemptRef.current;
      if (
        !attempt ||
        attempt.runScopeGeneration !== renderedScopeGeneration ||
        !isActiveRunInvocation(runScopeKey, renderedScopeGeneration)
      ) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
      const message = normalizeChatErrorMessage(error);
      // The append promise verifies canonical replay before deciding whether
      // this transport failure is also a product failure.
      logClientWarning("chat/stream", "failed", {
        runId,
        sessionId,
        error: message,
      });
      pushDebugEvent({
        phase: "error",
        summary: message,
        payload: {
          rawError: error.message,
          normalizedError: message,
        },
      });
      if (shouldLogStreamError(lastLoggedStreamErrorRef.current, message)) {
        console.error("🧬 [LegionCode] Chat Stream Error:", message);
        lastLoggedStreamErrorRef.current = {
          message,
          timestamp: Date.now(),
        };
      }
    },
    credentials: "include",
    fetch: authenticatedChatFetch,
  });

  useEffect(() => {
    latestComposerInputRef.current = input;
  }, [input]);

  const activeTurnProjection = useActiveTurnProjection({
    turnId: resolveActiveProjectionTurnId({
      activeTurnId: activeConversationScope?.turnId,
      // Never project a turn retained from the previous session/run. The
      // conversation scope is the identity gate for lifecycle rendering.
      serverTurnId: activeConversationScope ? serverTurnId : null,
      isSubmitting,
    }),
    transportLoading: isTransportLoading || isSubmitting,
  });
  const isAwaitingTurnAdmission =
    isSubmitting && pendingUserMessage?.scopeKey === runScopeKey;
  const canonicalRunLoading =
    isAwaitingTurnAdmission ||
    deriveCanonicalRunLoading(
      activeTurnProjection,
      isTransportLoading || isSubmitting || isStopping,
    );

  const projectionRefreshTurnRef = useRef<string | null>(null);
  const startedProjectionTurnId = activeTurnProjection.projection?.startedAt
    ? activeTurnProjection.turnId
    : null;
  useEffect(() => {
    if (
      !startedProjectionTurnId ||
      !isActiveRunScope(runScopeKey) ||
      projectionRefreshTurnRef.current === startedProjectionTurnId
    )
      return;
    projectionRefreshTurnRef.current = startedProjectionTurnId;
    // The title job starts before the workflow. Read its canonical projection
    // now rather than waiting for a potentially long-running chat response.
    onServerProjectionAvailable?.();
  }, [
    startedProjectionTurnId,
    isActiveRunScope,
    runScopeKey,
    onServerProjectionAvailable,
  ]);

  useEffect(() => {
    if (!activeTurnProjection.isTerminal) {
      return;
    }
    // Canonical terminal settlement owns the loading state. Do not stop the
    // text transport here: the terminal event can arrive before its final
    // transcript frame, and cancelling it races away the user/final messages.
    // Terminal replay hydration reconciles the canonical transcript.
    setIsSubmitting(false);
    setIsStopping(false);
  }, [activeTurnProjection.isTerminal, activeTurnProjection.turnId]);
  const presentationScopeKey = scopeKey ?? runScopeKey;
  const optimisticUserMessage =
    pendingUserMessage?.scopeKey === presentationScopeKey
      ? pendingUserMessage.message
      : null;

  const resetRun = useCallback(() => {
    if (!externalRunId) {
      setInternalRunId(createRunId());
    }
  }, [externalRunId]);

  const resolveSelectedProviderConfigForRequest = useCallback(
    (): ResolvedProviderConfig | null =>
      resolveSelectedProviderConfig({
        selectedProviderId,
        selectedModelId,
        selectedCredentialId,
        selectedModelContextWindow,
        selectedModelPricing,
        lastResolvedConfig,
      }),
    [
      lastResolvedConfig,
      selectedCredentialId,
      selectedModelId,
      selectedModelContextWindow,
      selectedModelPricing,
      selectedProviderId,
    ],
  );

  const resolveProviderConfigFromApi = useCallback(
    async (requestScopeKey: string): Promise<ResolvedProviderConfig | null> => {
      const resolvedConfig = await resolveForChat();
      if (!isActiveRunScope(requestScopeKey)) {
        return null;
      }

      return requireResolvedProviderConfig({
        providerId: resolvedConfig.providerId,
        modelId: resolvedConfig.modelId,
        credentialId: resolvedConfig.credentialId,
        contextWindow: resolvedConfig.contextWindow,
        pricing: resolvedConfig.pricing,
        source: "provider_resolve_api",
      });
    },
    [isActiveRunScope, resolveForChat],
  );

  const buildChatRequestBody = useCallback(
    (
      config: ResolvedProviderConfig,
      clientMessageId: string,
      identity: ConversationScope,
    ): ChatRequestBody =>
      parseChatRequestBody({
        sessionId: identity.sessionId,
        runId: identity.runId,
        clientMessageId,
        mode,
        productMode,
        harnessId: resolveRuntimeHarnessId(sessionId),
        providerId: config.providerId,
        modelId: config.modelId,
        ...(resolveReasoningEffortForRequest(
          config.providerId,
          config.modelId,
          selectedModelEfforts,
        )
          ? {
              reasoningEffort: resolveReasoningEffortForRequest(
                config.providerId,
                config.modelId,
                selectedModelEfforts,
              ),
            }
          : {}),
        identity: {
          workspaceId: identity.workspaceId,
          threadId: identity.threadId,
          turnId: identity.turnId,
          runAttemptId: identity.runAttemptId,
          ...(identity.revisionOfTurnId
            ? { revisionOfTurnId: identity.revisionOfTurnId }
            : {}),
        },
        ...loadRepositoryContextFields(sessionId),
      }),
    [mode, productMode, selectedModelEfforts, sessionId],
  );

  const pushChatRequestDebugEvent = useCallback(
    (
      message: ChatAppendMessage,
      requestBody: ChatRequestBody,
      config: ResolvedProviderConfig,
    ) => {
      const text = extractTextContent(message.content);
      pushDebugEvent({
        phase: "request",
        summary: `POST ${apiPath}`,
        payload: {
          endpoint: apiPath,
          requestBody,
          clientMessageId: message.id,
          userContentHash: hashLogString(text),
          imageAttachments:
            message.imageMetadata ??
            toRedactedImageMetadataFromParts(message.content),
          resolvedConfig: {
            providerId: config.providerId,
            modelId: config.modelId,
            credentialId: config.credentialId,
            source: config.source,
          },
        },
      });
    },
    [apiPath, pushDebugEvent],
  );

  const submitResolvedMessage = useCallback(
    async (
      message: ChatAppendMessage,
      requestBody: ChatRequestBody,
    ): Promise<void> => {
      const appendMultimodal = append as (
        input: ChatAppendMessage,
        options: { body: ChatRequestBody },
      ) => Promise<string | null | undefined>;
      logClientEvent("chat/append", "dispatching", {
        runId,
        sessionId,
        scopeKey,
        clientMessageId: message.id,
        requestRunId: requestBody.runId,
        requestSessionId: requestBody.sessionId,
        providerId: requestBody.providerId,
        modelId: requestBody.modelId,
      });
      const responseMessageId = await appendMultimodal(message, {
        body: requestBody,
      });
      logClientEvent("chat/append", "returned", {
        runId,
        sessionId,
        scopeKey,
        clientMessageId: message.id,
        responseMessageId: responseMessageId ?? null,
      });
    },
    [append, runId, scopeKey, sessionId],
  );

  const appendWithResolution = useCallback(
    async (
      message: ChatAppendMessage,
      revisionTarget?: string,
    ): Promise<SubmissionOutcome> => {
      const bootstrapScopeKey = runScopeKey;
      const bootstrapScopeGeneration = runScopeGenerationRef.current;
      const ownsInvocationScope = () =>
        runScopeGenerationRef.current === bootstrapScopeGeneration &&
        isActiveRunScope(bootstrapScopeKey);
      const content = extractTextContent(message.content).trim();
      const hasImages = messageHasImageParts(message);
      if ((!content && !hasImages) || status !== "ready") {
        return {
          status: "unconfirmed",
          message:
            "Chat is still establishing its server-owned turn scope or model settings. Wait a moment, then try again.",
        };
      }
      const intentKey = message.id
        ? `explicit:${message.id}`
        : revisionTarget
          ? `revision:${revisionTarget}`
          : "composer";
      const intentFingerprint = JSON.stringify({
        sessionId,
        content: message.content,
        imageMetadata: message.imageMetadata ?? null,
        revisionTarget: revisionTarget ?? null,
        mode,
        productMode: productMode ?? null,
        providerId: selectedProviderId ?? null,
        credentialId: selectedCredentialId ?? null,
        modelId: selectedModelId ?? null,
        reasoningEffort:
          resolveReasoningEffortForRequest(
            selectedProviderId ?? "",
            selectedModelId ?? "",
            selectedModelEfforts,
          ) ?? null,
        harnessId: resolveRuntimeHarnessId(sessionId),
        repository: loadRepositoryContextFields(sessionId),
      });
      const activeAttempt = activeSubmissionAttemptRef.current;
      if (
        activeAttempt?.active &&
        activeAttempt.sessionId === sessionId &&
        activeAttempt.runScopeGeneration === bootstrapScopeGeneration
      ) {
        return {
          status: "unconfirmed",
          message:
            "Another submission is still settling for this chat. Wait for it to finish, then retry this intent.",
        };
      }
      const acquired = acquireSubmissionAttempt({
        sessionId,
        runId,
        runScopeGeneration: bootstrapScopeGeneration,
        clientMessageId: message.id,
        intentKey,
        intentFingerprint,
      });
      if (!acquired) {
        return {
          status: "unconfirmed",
          message:
            "This submission is already in flight or its client identity belongs to a different intent.",
        };
      }
      if (acquired.previousOutcome) return acquired.previousOutcome;
      const attempt = acquired.attempt;
      const ownsSubmissionAttempt = () =>
        activeSubmissionAttemptRef.current?.token === attempt.token &&
        ownsInvocationScope();
      retainedSubmissionScopeRef.current = acquired.reused
        ? attempt.scope
        : null;
      activeSubmissionAttemptRef.current = attempt;
      const submittedMessage = ensureClientMessageId({
        ...message,
        id: attempt.clientMessageId,
      });
      setError(null);
      setIsSubmitting(true);
      setIsStopping(false);
      // The previous scope may already be terminal. Clear it before admission
      // so a lagging serverTurnId cannot make a fresh submission look settled.
      setConversationScope(null);
      activeConversationScopeRef.current = null;
      activeScopeKeyRef.current = bootstrapScopeKey;
      preAdmissionStopKeyRef.current = null;
      stopRequestedRef.current = false;
      setPendingUserMessage({
        scopeKey: bootstrapScopeKey,
        message: buildPendingUserMessage(submittedMessage),
      });
      setOptimisticUserMessageId(submittedMessage.id ?? null);
      logClientEvent("chat/pending-user", "projected", {
        runId,
        sessionId,
        scopeKey: bootstrapScopeKey,
        clientMessageId: submittedMessage.id,
        userContentHash: hashLogString(content),
      });
      logClientEvent("chat/submit", "started", {
        runId,
        sessionId,
        scopeKey: bootstrapScopeKey,
        clientMessageId: submittedMessage.id,
        userContentHash: hashLogString(content),
        hasText: Boolean(content),
        imageCount: submittedMessage.imageMetadata?.length ?? 0,
      });
      dispatchRunSummaryRefresh(runId);

      try {
        const providerConfig =
          resolveSelectedProviderConfigForRequest() ??
          (await resolveProviderConfigFromApi(bootstrapScopeKey));
        if (!providerConfig) {
          logClientWarning("chat/submit", "aborted", {
            runId,
            sessionId,
            scopeKey: bootstrapScopeKey,
            reason: "provider-resolution-unavailable",
          });
          if (!ownsInvocationScope()) {
            finishSubmissionAttempt(attempt, { status: "inactive" });
            return { status: "inactive" };
          }
          throw new Error(
            "The selected provider configuration is unavailable. Reconnect the provider or choose another model, then try again.",
          );
        }
        if (
          stopRequestedRef.current &&
          preAdmissionStopKeyRef.current === bootstrapScopeKey
        ) {
          const outcome = cancelledBeforeDispatch(attempt);
          finishSubmissionAttempt(attempt, outcome);
          return outcome;
        }
        if (!ownsInvocationScope()) {
          logClientWarning("chat/submit", "aborted", {
            runId,
            sessionId,
            scopeKey: bootstrapScopeKey,
            reason: "inactive-scope-after-provider-resolution",
          });
          const outcome: SubmissionOutcome = { status: "inactive" };
          finishSubmissionAttempt(attempt, outcome);
          return outcome;
        }

        const requestScope =
          attempt.scope ??
          (await bootstrapConversationScope(
            sessionId,
            runId,
            submittedMessage.id,
            revisionTarget,
          ));
        retainSubmissionReservation(attempt, requestScope);
        if (!ownsInvocationScope()) {
          const outcome: SubmissionOutcome = {
            status: "inactive",
            scope: requestScope,
          };
          finishSubmissionAttempt(attempt, outcome);
          return outcome;
        }
        const requestScopeKey = conversationScopeKey(requestScope);
        activeScopeKeyRef.current = requestScopeKey;
        activeConversationScopeRef.current = requestScope;
        setConversationScope(requestScope);
        setError((current) =>
          isTurnScopeRecoveryError(current) ? null : current,
        );
        publishConversationScopeReady(requestScope);
        setPendingUserMessage({
          scopeKey: requestScopeKey,
          message: buildPendingUserMessage(submittedMessage, requestScope),
        });

        if (
          attempt.stopRequested ||
          (stopRequestedRef.current &&
            preAdmissionStopKeyRef.current === bootstrapScopeKey)
        ) {
          const outcome = cancelledBeforeDispatch(attempt, requestScope);
          finishSubmissionAttempt(attempt, outcome);
          if (
            !(
              outcome.status === "cancelled" && outcome.admission === "accepted"
            ) &&
            activeSubmissionAttemptRef.current?.token === attempt.token &&
            ownsInvocationScope()
          ) {
            retainedSubmissionScopeRef.current = null;
            setConversationScope(null);
            activeConversationScopeRef.current = null;
            activeScopeKeyRef.current = bootstrapScopeKey;
            setPendingUserMessage(null);
            setOptimisticUserMessageId(null);
          }
          return outcome;
        }

        const requestBody = buildChatRequestBody(
          providerConfig,
          submittedMessage.id,
          requestScope,
        );
        logClientEvent("chat/submit", "provider-resolved", {
          runId,
          sessionId,
          scopeKey: requestScopeKey,
          clientMessageId: submittedMessage.id,
          providerId: providerConfig.providerId,
          modelId: providerConfig.modelId,
          source: providerConfig.source,
        });
        pushChatRequestDebugEvent(
          submittedMessage,
          requestBody,
          providerConfig,
        );
        dispatchRunSummaryRefresh(runId);
        try {
          await submitResolvedMessage(submittedMessage, requestBody);
        } catch (transportError) {
          attempt.transportError ??=
            transportError instanceof Error
              ? transportError.message
              : String(transportError);
        }
        const positivelyAcknowledged =
          attempt.responseStatus !== null &&
          attempt.responseStatus >= 200 &&
          attempt.responseStatus < 300 &&
          attempt.responseTupleMatches;
        const canonicalTurnAccepted =
          positivelyAcknowledged ||
          (await hasCanonicalLifecycleEvidence(lifecycleClient, requestScope));
        if (attempt.stopRequested && canonicalTurnAccepted) {
          try {
            await interruptAndAbortTransport(
              lifecycleClient,
              requestScope,
              () => {
                if (ownsSubmissionAttempt()) stopStream();
              },
            );
          } catch (interruptError) {
            if (ownsSubmissionAttempt()) {
              stopRequestedRef.current = false;
              setError(
                "Stop could not be confirmed. Check the saved turn status or try Stop again.",
              );
            }
            logClientWarning("chat/stop", "accepted-turn-interrupt-unsettled", {
              runId: requestScope.runId,
              sessionId: requestScope.sessionId,
              scopeKey: requestScopeKey,
              error:
                interruptError instanceof Error
                  ? interruptError.message
                  : String(interruptError),
            });
          }
          const outcome: SubmissionOutcome = {
            status: "cancelled",
            admission: "accepted",
            scope: requestScope,
          };
          finishSubmissionAttempt(attempt, outcome);
          return outcome;
        }
        if (!canonicalTurnAccepted) {
          const message =
            attempt.transportError ??
            (attempt.responseStatus === null
              ? "The chat request ended without a bound admission acknowledgement. Retry this same intent manually."
              : `Chat admission could not be confirmed (HTTP ${attempt.responseStatus}). Retry this same intent manually.`);
          if (attempt.stopRequested && attempt.dispatched) {
            try {
              await interruptAndAwaitTerminal(
                lifecycleClient,
                requestScope,
                () => {
                  if (ownsSubmissionAttempt()) stopStream();
                },
              );
              const outcome: SubmissionOutcome = {
                status: "cancelled",
                admission: "accepted",
                scope: requestScope,
              };
              finishSubmissionAttempt(attempt, outcome);
              return outcome;
            } catch (interruptError) {
              logClientWarning("chat/stop", "uncertain-interrupt-failed", {
                runId: requestScope.runId,
                sessionId: requestScope.sessionId,
                scopeKey: requestScopeKey,
                error:
                  interruptError instanceof Error
                    ? interruptError.message
                    : String(interruptError),
              });
            }
          }
          const outcome: SubmissionOutcome = attempt.stopRequested
            ? {
                status: "cancelled",
                admission: "unconfirmed",
                scope: requestScope,
              }
            : { status: "unconfirmed", scope: requestScope, message };
          finishSubmissionAttempt(attempt, outcome);
          if (
            activeSubmissionAttemptRef.current?.token === attempt.token &&
            ownsInvocationScope()
          ) {
            retainedSubmissionScopeRef.current = null;
            setConversationScope(null);
            activeConversationScopeRef.current = null;
            activeScopeKeyRef.current = bootstrapScopeKey;
            if (outcome.status === "unconfirmed") setError(message);
            setPendingUserMessage(null);
            setOptimisticUserMessageId(null);
          }
          return outcome;
        }
        if (
          activeSubmissionAttemptRef.current?.token === attempt.token &&
          ownsInvocationScope()
        )
          setError(null);
        const outcome: SubmissionOutcome = {
          status: "accepted",
          scope: requestScope,
        };
        finishSubmissionAttempt(attempt, outcome);
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome: SubmissionOutcome = {
          status: attempt.stopRequested ? "cancelled" : "unconfirmed",
          ...(attempt.stopRequested
            ? {
                admission:
                  attempt.dispatched || attempt.hadPriorDispatch
                    ? ("unconfirmed" as const)
                    : ("not-dispatched" as const),
              }
            : {}),
          ...(attempt.scope ? { scope: attempt.scope } : {}),
          ...(attempt.stopRequested ? {} : { message }),
        } as SubmissionOutcome;
        finishSubmissionAttempt(attempt, outcome);
        if (
          outcome.status === "unconfirmed" &&
          activeSubmissionAttemptRef.current?.token === attempt.token &&
          ownsInvocationScope()
        ) {
          retainedSubmissionScopeRef.current = null;
          setConversationScope(null);
          activeConversationScopeRef.current = null;
          activeScopeKeyRef.current = bootstrapScopeKey;
          setError(message);
          setPendingUserMessage(null);
          setOptimisticUserMessageId(null);
        } else if (
          outcome.status === "cancelled" &&
          outcome.admission === "unconfirmed" &&
          activeSubmissionAttemptRef.current?.token === attempt.token &&
          ownsInvocationScope()
        ) {
          retainedSubmissionScopeRef.current = null;
          setConversationScope(null);
          activeConversationScopeRef.current = null;
          activeScopeKeyRef.current = bootstrapScopeKey;
          setPendingUserMessage(null);
          setOptimisticUserMessageId(null);
        }
        return outcome;
      } finally {
        const ownsSettlement =
          activeSubmissionAttemptRef.current?.token === attempt.token;
        if (ownsSettlement) {
          activeSubmissionAttemptRef.current = null;
        }
        if (ownsSettlement && ownsInvocationScope()) {
          const settledScopeKey = activeScopeKeyRef.current;
          setIsSubmitting(false);
          logClientEvent("chat/submit", "settled", {
            runId,
            sessionId,
            scopeKey: settledScopeKey,
            clientMessageId: submittedMessage.id,
          });
        }
      }
    },
    [
      buildChatRequestBody,
      isActiveRunScope,
      lifecycleClient,
      mode,
      productMode,
      pushChatRequestDebugEvent,
      resolveProviderConfigFromApi,
      resolveSelectedProviderConfigForRequest,
      runId,
      runScopeKey,
      sessionId,
      selectedCredentialId,
      selectedModelEfforts,
      selectedModelId,
      selectedProviderId,
      status,
      stopStream,
      submitResolvedMessage,
    ],
  );

  const shouldBlockSubmit = useCallback(
    (content: string, hasImages: boolean) =>
      (!content && !hasImages) || canonicalRunLoading || !isModelConfigReady,
    [canonicalRunLoading, isModelConfigReady],
  );

  const clearChatInput = useCallback(() => {
    updateChatInput("", handleInputChange);
  }, [handleInputChange]);

  const restoreChatInput = useCallback(
    (value: string) => {
      updateChatInput(value, handleInputChange);
    },
    [handleInputChange],
  );

  const handleSubmitFailure = useCallback(
    (
      error: unknown,
      requestScopeKey: string,
      originalInput: string,
      composerToken: string,
      scopeGeneration: number,
    ) => {
      if (
        activeComposerSubmissionRef.current !== composerToken ||
        (!isActiveRunInvocation(requestScopeKey, scopeGeneration) &&
          (runScopeGenerationRef.current !== scopeGeneration ||
            !isActiveScope(requestScopeKey)))
      ) {
        return;
      }
      if (latestComposerInputRef.current === "") {
        restoreChatInput(originalInput);
      }
      // A successful bootstrap replaces the pre-admission scope key with the
      // canonical turn scope. If the subsequent transport request is rejected,
      // this handler still owns the only active submission and must clear that
      // projection as well; otherwise the UI remains stuck on "Starting".
      setPendingUserMessage(null);
      setOptimisticUserMessageId(null);
      const message =
        error instanceof Error
          ? normalizeChatErrorMessage(error)
          : "Failed to send message.";
      setError(message);
      logClientWarning("chat/submit", "failed", {
        runId,
        sessionId,
        scopeKey: requestScopeKey,
        error: message,
      });
      pushDebugEvent({
        phase: "error",
        summary: message,
        payload: {
          source: "appendWithResolution",
          error:
            error instanceof Error ? error.message : "Unknown append error",
        },
      });
      logClientWarning("chat/submit", "append-failed", {
        runId,
        sessionId,
        scopeKey: requestScopeKey,
        error: error instanceof Error ? error.message : "Unknown append error",
      });
    },
    [
      isActiveScope,
      isActiveRunInvocation,
      pushDebugEvent,
      restoreChatInput,
      runId,
      sessionId,
    ],
  );

  const submitPreparedInput = useCallback(
    async (
      message: ChatAppendMessage,
      requestScopeKey: string,
      originalInput: string,
      composerToken: string,
      scopeGeneration: number,
    ): Promise<boolean> => {
      const outcome = await appendWithResolution(message);
      if (outcome.status === "accepted") return true;
      if (outcome.status === "cancelled" && outcome.admission === "accepted")
        return true;
      const stillOwnsComposer =
        activeComposerSubmissionRef.current === composerToken &&
        isActiveRunInvocation(requestScopeKey, scopeGeneration);
      if (!stillOwnsComposer) return false;
      if (outcome.status === "unconfirmed") {
        handleSubmitFailure(
          new Error(outcome.message),
          requestScopeKey,
          originalInput,
          composerToken,
          scopeGeneration,
        );
      } else if (
        outcome.status === "cancelled" &&
        outcome.admission === "unconfirmed"
      ) {
        handleSubmitFailure(
          new Error(
            "The stopped chat request may have been admitted. Retry only after checking the saved conversation.",
          ),
          requestScopeKey,
          originalInput,
          composerToken,
          scopeGeneration,
        );
      } else {
        if (latestComposerInputRef.current === "")
          restoreChatInput(originalInput);
      }
      return false;
    },
    [
      appendWithResolution,
      handleSubmitFailure,
      isActiveRunInvocation,
      restoreChatInput,
    ],
  );

  const handleSubmit = useCallback(
    async (
      e?: FormEvent,
      attachments?: ChatSubmitAttachments,
    ): Promise<boolean> => {
      e?.preventDefault();
      const originalInput = input;
      const trimmedInput = input.trim();
      const imageAttachments = attachments?.imageAttachments ?? [];
      if (shouldBlockSubmit(trimmedInput, imageAttachments.length > 0)) {
        logClientWarning("chat/submit", "blocked", {
          runId,
          sessionId,
          hasText: Boolean(trimmedInput),
          imageCount: imageAttachments.length,
          isLoading: canonicalRunLoading,
          isSubmitting,
          isStopping,
          isModelConfigReady,
        });
        return false;
      }
      const requestScopeKey = runScopeKey;
      const scopeGeneration = runScopeGenerationRef.current;
      const composerToken = crypto.randomUUID();
      activeComposerSubmissionRef.current = composerToken;
      clearChatInput();
      return submitPreparedInput(
        buildChatAppendMessage(trimmedInput, imageAttachments),
        requestScopeKey,
        originalInput,
        composerToken,
        scopeGeneration,
      );
    },
    [
      clearChatInput,
      input,
      canonicalRunLoading,
      isModelConfigReady,
      isStopping,
      isSubmitting,
      runId,
      runScopeKey,
      sessionId,
      shouldBlockSubmit,
      submitPreparedInput,
    ],
  );

  const stop = useCallback(() => {
    if (stopRequestedRef.current) {
      return;
    }
    const requestRunId = runId;
    const stopGeneration = renderedScopeGeneration;
    const requestScope = activeConversationScopeRef.current;
    const submissionAttempt = activeSubmissionAttemptRef.current;
    const stopOwnsInvocation = () =>
      isActiveRunInvocation(runScopeKey, stopGeneration) &&
      (submissionAttempt
        ? activeSubmissionAttemptRef.current === null ||
          activeSubmissionAttemptRef.current.token === submissionAttempt.token
        : activeSubmissionAttemptRef.current === null &&
          (!requestScope ||
            activeConversationScopeRef.current?.turnId ===
              requestScope.turnId));
    stopRequestedRef.current = true;
    if (submissionAttempt) submissionAttempt.stopRequested = true;
    setIsSubmitting(false);
    setIsStopping(true);
    dispatchRunSummaryRefresh(requestRunId);

    const cancelRun = async (): Promise<void> => {
      try {
        if (submissionAttempt && !submissionAttempt.dispatched) {
          preAdmissionStopKeyRef.current = runScopeKey;
          if (stopOwnsInvocation()) stopStream();
          setPendingUserMessage(null);
          setOptimisticUserMessageId(null);
        } else if (submissionAttempt?.dispatched) {
          // The submission owns reconciliation. It will interrupt this exact
          // reservation only if the response and canonical evidence are both
          // absent after transport cancellation.
          if (stopOwnsInvocation()) stopStream();
        } else if (requestScope) {
          await interruptAndAbortTransport(
            lifecycleClient,
            requestScope,
            () => {
              if (stopOwnsInvocation()) stopStream();
            },
          );
        } else {
          preAdmissionStopKeyRef.current = runScopeKey;
          if (stopOwnsInvocation()) stopStream();
          setPendingUserMessage(null);
          setOptimisticUserMessageId(null);
        }
        dispatchRunSummaryRefresh(requestRunId);
      } catch (error) {
        if (stopOwnsInvocation()) {
          stopRequestedRef.current = false;
          setError(
            error instanceof Error
              ? normalizeChatErrorMessage(error)
              : "Failed to stop the turn.",
          );
          logClientWarning("chat/stop", "interrupt-failed", {
            runId: requestRunId,
            scopeKey: scopeKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (stopOwnsInvocation()) {
          setIsStopping(false);
        }
      }
    };

    void cancelRun();
  }, [
    isActiveRunInvocation,
    lifecycleClient,
    runId,
    runScopeKey,
    renderedScopeGeneration,
    scopeKey,
    stopStream,
  ]);

  const reviseTurn = useCallback(
    async (turnId: string, content: string): Promise<boolean> => {
      const parsedTurnId = TurnIdSchema.safeParse(turnId);
      const trimmed = content.trim();
      if (!parsedTurnId.success || !trimmed) return false;
      const outcome = await appendWithResolution(
        { role: "user", content: trimmed },
        parsedTurnId.data,
      );
      return outcome.status === "accepted";
    },
    [appendWithResolution],
  );

  return {
    optimisticUserMessage,
    optimisticUserMessageId,
    input,
    handleInputChange,
    handleSubmit,
    append: appendWithResolution,
    isLoading: canonicalRunLoading,
    stop,
    runId,
    scope: activeConversationScope,
    serverTurnId,
    activeTurnProjection,
    resetRun,
    isModelConfigReady,
    error,
    clearNonCanonicalError,
    debugEvents,
    reviseTurn,
  };
}

export async function interruptAndAwaitTerminal(
  lifecycleClient: ReturnType<typeof createLifecycleClient>,
  scope: ConversationScope,
  onInterruptAccepted: () => void,
): Promise<void> {
  const settlementAbort = new AbortController();
  const settlementTimeout = window.setTimeout(
    () =>
      settlementAbort.abort(
        "Timed out waiting for interrupted terminal event.",
      ),
    15_000,
  );
  let iterator: AsyncIterator<
    import("../services/api/lifecycleClient").LifecycleEvent
  > | null = null;
  try {
    const response = await requestExactInterrupt(
      lifecycleClient,
      scope,
      settlementAbort.signal,
    );
    // The runtime command is now durably admitted. Stop the chat transport
    // immediately so the composer reflects the user's hard-stop action while
    // lifecycle continuation independently waits for canonical settlement.
    const terminalAlreadySettled = isExactTerminalEvent(
      response.terminalEvent,
      scope,
    );
    if (response.accepted || terminalAlreadySettled) onInterruptAccepted();
    if (terminalAlreadySettled) return;
    const events = lifecycleClient.followTurnLifecycle(
      { turnId: TurnIdSchema.parse(scope.turnId) },
      { signal: settlementAbort.signal },
    );
    iterator = events[Symbol.asyncIterator]();
    while (true) {
      const next = await raceWithAbort(iterator.next(), settlementAbort.signal);
      if (next.done) break;
      const event = next.value;
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        if (isExactTerminalEvent(event, scope)) return;
      }
    }
    throw new Error(
      "The exact reserved turn did not produce a canonical terminal event.",
    );
  } finally {
    window.clearTimeout(settlementTimeout);
    settlementAbort.abort("Turn interruption settlement ended.");
    if (iterator?.return) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}

async function interruptAndAbortTransport(
  lifecycleClient: ReturnType<typeof createLifecycleClient>,
  scope: ConversationScope,
  onInterruptAccepted: () => void,
): Promise<void> {
  const abort = new AbortController();
  const timeout = window.setTimeout(
    () => abort.abort("Timed out sending the interrupt command."),
    15_000,
  );
  try {
    const response = await requestExactInterrupt(
      lifecycleClient,
      scope,
      abort.signal,
    );
    if (
      response.accepted ||
      isExactTerminalEvent(response.terminalEvent, scope)
    ) {
      onInterruptAccepted();
    }
  } finally {
    window.clearTimeout(timeout);
    abort.abort("Interrupt command completed.");
  }
}

async function requestExactInterrupt(
  lifecycleClient: ReturnType<typeof createLifecycleClient>,
  scope: ConversationScope,
  signal: AbortSignal,
): Promise<import("@repo/platform-client-sdk").InterruptTurnResponse> {
  const response = await raceWithAbort(
    lifecycleClient.interruptTurn(
      {
        runId: RunIdSchema.parse(scope.runId),
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        threadId: ThreadIdSchema.parse(scope.threadId),
        turnId: TurnIdSchema.parse(scope.turnId),
        runAttemptId: RunAttemptIdSchema.parse(scope.runAttemptId),
        reason: "User stopped the turn.",
      },
      { signal },
    ),
    signal,
  );
  if (response.runId !== scope.runId) {
    throw new Error("The interrupt response did not match the requested run.");
  }
  if (!response.accepted && !isExactTerminalEvent(response.terminalEvent, scope)) {
    throw new Error("The runtime did not accept the interrupt request.");
  }
  return response;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Turn interruption settlement timed out."));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Turn interruption settlement timed out."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function cancelledBeforeDispatch(
  attempt: SubmissionAttempt,
  scope?: ConversationScope,
): SubmissionOutcome {
  return {
    status: "cancelled",
    admission: attempt.hadPriorDispatch ? "unconfirmed" : "not-dispatched",
    ...(scope ? { scope } : {}),
  };
}

function isExactTerminalEvent(
  event: import("@repo/platform-client-sdk").LifecycleEvent | null | undefined,
  scope: ConversationScope,
): boolean {
  return Boolean(
    event &&
    (event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.interrupted") &&
    event.threadId === scope.threadId &&
    event.turnId === scope.turnId &&
    event.runAttemptId === scope.runAttemptId,
  );
}

export function buildChatAppendMessage(
  text: string,
  imageAttachments: ChatImageAttachment[],
): ChatAppendMessage {
  if (imageAttachments.length === 0) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: text || "Analyze the attached image(s).",
      },
      ...toImageParts(imageAttachments),
    ],
    imageMetadata: toRedactedImageMetadata(imageAttachments),
  };
}

function extractTextContent(content: ChatUserContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function buildPendingUserMessage(
  message: ChatAppendMessage,
  identity?: ConversationScope,
): Message {
  const metadata = {
    ...(identity
      ? {
          canonicalIdentity: {
            workspaceId: identity.workspaceId,
            threadId: identity.threadId,
            turnId: identity.turnId,
            runAttemptId: identity.runAttemptId,
          },
        }
      : {}),
    ...(message.imageMetadata
      ? { imageAttachments: message.imageMetadata }
      : {}),
  };
  return {
    id: message.id ?? createClientMessageId(),
    role: "user",
    // Preserve typed image parts for the optimistic transcript. The server
    // intentionally redacts image bytes from durable transcript rows; this
    // gives the current turn a real preview without creating a second store.
    content: message.content as Message["content"],
    createdAt: new Date(),
    ...(Object.keys(metadata).length > 0 ? { data: { metadata } } : {}),
  } as Message;
}

function ensureClientMessageId(
  message: ChatAppendMessage,
): ChatAppendMessage & {
  id: string;
} {
  return {
    ...message,
    id: message.id ?? createClientMessageId(),
  };
}

function createClientMessageId(): string {
  return `client_msg_${crypto.randomUUID()}`;
}

function hashLogString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function messageHasImageParts(message: ChatAppendMessage): boolean {
  return Array.isArray(message.content)
    ? message.content.some((part) => part.type === "image")
    : false;
}

function toRedactedImageMetadataFromParts(content: ChatUserContent) {
  if (!Array.isArray(content)) {
    return [];
  }
  const syntheticAttachments = content
    .filter((part) => part.type === "image")
    .map((part, index) => ({
      id: `image-${index + 1}`,
      name: part.name,
      mediaType: part.mimeType as ChatImageAttachment["mediaType"],
      byteSize: 0,
      source: "paste" as const,
      dataUrl: "",
      previewUrl: "",
    }));
  return toRedactedImageMetadata(syntheticAttachments);
}

function updateChatInput(
  value: string,
  handleInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void,
): void {
  handleInputChange({
    target: { value },
  } as ChangeEvent<HTMLTextAreaElement>);
}

function fetchWithSessionAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});

  return fetch(input, {
    ...init,
    credentials: "include",
    headers,
  });
}
