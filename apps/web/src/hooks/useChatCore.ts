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
  useActiveTurnProjection,
  deriveCanonicalRunLoading,
  resolveActiveProjectionTurnId,
  type ActiveTurnProjection,
} from "./useActiveTurnProjection.js";

type ChatUserContent =
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

interface ChatAppendMessage {
  id?: string;
  role: "user";
  content: ChatUserContent;
  imageMetadata?: ReturnType<typeof toRedactedImageMetadata>;
}

interface ChatSubmitAttachments {
  imageAttachments?: ChatImageAttachment[];
}

interface UseChatCoreResult {
  messages: Message[];
  input: string;
  handleInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (
    e?: FormEvent,
    attachments?: ChatSubmitAttachments,
  ) => Promise<boolean>;
  append: (message: ChatAppendMessage) => Promise<void>;
  isLoading: boolean;
  stop: () => void;
  setMessages: (messages: Message[]) => void;
  runId: string;
  scope: ConversationScope | null;
  serverTurnId: string | null;
  activeTurnProjection: ActiveTurnProjection;
  resetRun: () => void;
  isModelConfigReady: boolean;
  error: string | null;
  clearNonCanonicalError: () => void;
  debugEvents: ChatDebugEvent[];
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
  const [debugEvents, setDebugEvents] = useState<ChatDebugEvent[]>([]);
  const preAdmissionStopKeyRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
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
    conversationScope.runId === runId
      ? conversationScope
      : null;
  const scopeKey = activeConversationScope
    ? conversationScopeKey(activeConversationScope)
    : null;
  const runScopeKey = `${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}`;
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

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    activeConversationScopeRef.current = activeConversationScope;
    setServerTurnId(activeConversationScope?.turnId ?? null);
    setPendingUserMessage((current) =>
      current?.scopeKey === scopeKey ? current : null,
    );
  }, [activeConversationScope, scopeKey]);

  useEffect(() => {
    activeRunScopeKeyRef.current = runScopeKey;
    preAdmissionStopKeyRef.current = null;
    stopRequestedRef.current = false;
    setError(null);
    setIsSubmitting(false);
    setIsStopping(false);
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
        if (controller.signal.aborted || !isActiveRunScope(requestRunScopeKey)) {
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
        if (controller.signal.aborted || !isActiveRunScope(requestRunScopeKey)) {
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
      ? (
          providerModels[selectedProviderId]?.find(
            (model) => model.id === selectedModelId,
          ) ??
          manageProviderModels[selectedProviderId]?.find(
            (model) => model.id === selectedModelId,
          )
        )
      : undefined;
  const selectedModelContextWindow = selectedModel?.contextWindow;
  const selectedModelPricing = selectedModel?.pricing;
  const selectedModelEfforts = selectedModel?.capabilities?.reasoningEfforts;
  const authenticatedChatFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithSessionAuth(input, init),
    [],
  );
  const hasConnectedCredential = credentials.length > 0;
  const isModelConfigReady =
    status === "ready" &&
    hasConnectedCredential;
  const lifecycleClient = useMemo(() => createLifecycleClient(), []);

  const {
    messages,
    input,
    handleInputChange,
    isLoading: isTransportLoading,
    stop: stopStream,
    setMessages,
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
            },
          }
        : {}),
    },
    initialMessages: [],
    id: instanceKey,
    onResponse: (response: Response) => {
      if (!isActiveRunScope(runScopeKey)) {
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
      if (!isActiveRunScope(runScopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
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
      if (!isActiveRunScope(runScopeKey)) {
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

  const activeTurnProjection = useActiveTurnProjection({
    turnId: resolveActiveProjectionTurnId({
      activeTurnId: activeConversationScope?.turnId,
      serverTurnId,
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
  const scopedMessagesBase = messages;
  const presentationScopeKey = scopeKey ?? runScopeKey;
  const scopedMessages = useMemo(
    () =>
      appendPendingUserMessage(
        scopedMessagesBase,
        pendingUserMessage?.scopeKey === presentationScopeKey
          ? pendingUserMessage.message
          : null,
      ),
    [pendingUserMessage, presentationScopeKey, scopedMessagesBase],
  );
  useEffect(() => {
    if (
      !pendingUserMessage ||
      pendingUserMessage.scopeKey !== presentationScopeKey ||
      !hasEquivalentLatestUserMessage(
        scopedMessagesBase,
        pendingUserMessage.message,
      )
    ) {
      return;
    }
    setPendingUserMessage((current) =>
      current === pendingUserMessage ? null : current,
    );
  }, [pendingUserMessage, presentationScopeKey, scopedMessagesBase]);
  useEffect(() => {
    logClientEvent("chat/messages", "scoped-derived", {
      runId,
      sessionId,
      baseCount: scopedMessagesBase.length,
      finalCount: scopedMessages.length,
      pendingUser: Boolean(
        pendingUserMessage?.scopeKey === presentationScopeKey,
      ),
      baseRoles: summarizeMessageRoles(scopedMessagesBase),
      finalRoles: summarizeMessageRoles(scopedMessages),
      baseIds: summarizeMessageIdentities(scopedMessagesBase),
      finalIds: summarizeMessageIdentities(scopedMessages),
    });
  }, [
    pendingUserMessage,
    runId,
    scopedMessages,
    scopedMessagesBase,
    presentationScopeKey,
    sessionId,
  ]);

  const resetRun = useCallback(() => {
    if (!externalRunId) {
      setInternalRunId(createRunId());
    }
    // setMessages will be called after the new instance is created via instanceKey change
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
        sessionId,
        runId,
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
        },
        ...loadRepositoryContextFields(sessionId),
      }),
    [mode, productMode, runId, selectedModelEfforts, sessionId],
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
    async (message: ChatAppendMessage): Promise<void> => {
      const bootstrapScopeKey = runScopeKey;
      const content = extractTextContent(message.content).trim();
      const hasImages = messageHasImageParts(message);
      if (
        (!content && !hasImages) ||
        status !== "ready"
      ) {
        throw new Error(
          "Chat is still establishing its server-owned turn scope or model settings. Wait a moment, then try again.",
        );
      }
      const submittedMessage = ensureClientMessageId(message);
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
          return;
        }
        if (
          stopRequestedRef.current &&
          preAdmissionStopKeyRef.current === bootstrapScopeKey
        ) {
          return;
        }
        if (!isActiveRunScope(runScopeKey)) {
          logClientWarning("chat/submit", "aborted", {
            runId,
            sessionId,
            scopeKey: bootstrapScopeKey,
            reason: "inactive-scope-after-provider-resolution",
          });
          return;
        }

        const requestScope = await bootstrapConversationScope(
          sessionId,
          runId,
          submittedMessage.id,
        );
        if (!isActiveRunScope(runScopeKey)) {
          return;
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
          stopRequestedRef.current &&
          preAdmissionStopKeyRef.current === bootstrapScopeKey
        ) {
          await interruptAndAwaitTerminal(
            lifecycleClient,
            requestScope,
          );
          stopStream();
          return;
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
          const canonicalTurnAccepted = await hasCanonicalLifecycleEvidence(
            lifecycleClient,
            TurnIdSchema.parse(requestScope.turnId),
          );
          if (!canonicalTurnAccepted) {
            throw transportError;
          }
          setError(null);
          logClientWarning("chat/stream", "transport-detached-after-acceptance", {
            runId,
            sessionId,
            scopeKey: requestScopeKey,
            clientMessageId: submittedMessage.id,
            error:
              transportError instanceof Error
                ? transportError.message
                : String(transportError),
          });
        }
      } finally {
        if (isActiveRunScope(runScopeKey)) {
          const settledScopeKey = activeScopeKeyRef.current;
          setIsSubmitting(false);
          logClientEvent("chat/pending-user", "cleared", {
            runId,
            sessionId,
            scopeKey: settledScopeKey,
            clientMessageId: submittedMessage.id,
          });
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
      pushChatRequestDebugEvent,
      resolveProviderConfigFromApi,
      resolveSelectedProviderConfigForRequest,
      runId,
      runScopeKey,
      sessionId,
      status,
      submitResolvedMessage,
    ],
  );

  const shouldBlockSubmit = useCallback(
    (content: string, hasImages: boolean) =>
      (!content && !hasImages) ||
      canonicalRunLoading ||
      !isModelConfigReady,
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
    (error: unknown, requestScopeKey: string, originalInput: string) => {
      if (
        requestScopeKey !== runScopeKey &&
        !isActiveScope(requestScopeKey)
      ) {
        return;
      }
      restoreChatInput(originalInput);
      // A successful bootstrap replaces the pre-admission scope key with the
      // canonical turn scope. If the subsequent transport request is rejected,
      // this handler still owns the only active submission and must clear that
      // projection as well; otherwise the UI remains stuck on "Starting".
      setPendingUserMessage(null);
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
    [isActiveScope, pushDebugEvent, restoreChatInput, runId, runScopeKey, sessionId],
  );

  const submitPreparedInput = useCallback(
    async (
      message: ChatAppendMessage,
      requestScopeKey: string,
      originalInput: string,
    ): Promise<boolean> => {
      try {
        await appendWithResolution(message);
        return true;
      } catch (error) {
        handleSubmitFailure(error, requestScopeKey, originalInput);
        return false;
      }
    },
    [appendWithResolution, handleSubmitFailure],
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
      clearChatInput();
      return submitPreparedInput(
        buildChatAppendMessage(trimmedInput, imageAttachments),
        requestScopeKey,
        originalInput,
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
    const requestScope = activeConversationScopeRef.current;
    stopRequestedRef.current = true;
    setIsSubmitting(false);
    setIsStopping(true);
    dispatchRunSummaryRefresh(requestRunId);

    const cancelRun = async (): Promise<void> => {
      try {
        if (requestScope) {
          await interruptAndAwaitTerminal(lifecycleClient, requestScope);
          stopStream();
        } else {
          preAdmissionStopKeyRef.current = runScopeKey;
          stopStream();
          setPendingUserMessage(null);
        }
        dispatchRunSummaryRefresh(requestRunId);
      } catch (error) {
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
      } finally {
        if (isActiveRunScope(runScopeKey)) {
          setIsStopping(false);
        }
      }
    };

    void cancelRun();
  }, [isActiveScope, lifecycleClient, runId, runScopeKey, scopeKey, stopStream]);

  return {
    messages: scopedMessages,
    input,
    handleInputChange,
    handleSubmit,
    append: appendWithResolution,
    isLoading: canonicalRunLoading,
    stop,
    setMessages,
    runId,
    scope: activeConversationScope,
    serverTurnId,
    activeTurnProjection,
    resetRun,
    isModelConfigReady,
    error,
    clearNonCanonicalError,
    debugEvents,
  };
}

async function interruptAndAwaitTerminal(
  lifecycleClient: ReturnType<typeof createLifecycleClient>,
  scope: ConversationScope,
): Promise<void> {
  const settlementAbort = new AbortController();
  const settlementTimeout = window.setTimeout(
    () =>
      settlementAbort.abort("Timed out waiting for interrupted terminal event."),
    15_000,
  );
  try {
    const response = await lifecycleClient.interruptTurn({
      runId: RunIdSchema.parse(scope.runId),
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      threadId: ThreadIdSchema.parse(scope.threadId),
      turnId: TurnIdSchema.parse(scope.turnId),
      runAttemptId: RunAttemptIdSchema.parse(scope.runAttemptId),
      reason: "User stopped the turn.",
    });
    if (response.terminalEvent) return;
    for await (const event of lifecycleClient.followTurnLifecycle(
      { turnId: TurnIdSchema.parse(scope.turnId) },
      { signal: settlementAbort.signal },
    )) {
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        return;
      }
    }
  } finally {
    window.clearTimeout(settlementTimeout);
  }
}

function buildChatAppendMessage(
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
  const content = extractTextContent(message.content).trim();
  return {
    id: message.id ?? createClientMessageId(),
    role: "user",
    content: content || "Analyze the attached image(s).",
    createdAt: new Date(),
    ...(identity
      ? {
          data: {
            metadata: {
              canonicalIdentity: {
                workspaceId: identity.workspaceId,
                threadId: identity.threadId,
                turnId: identity.turnId,
                runAttemptId: identity.runAttemptId,
              },
            },
          },
        }
      : {}),
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

function appendPendingUserMessage(
  messages: Message[],
  pending: Message | null,
): Message[] {
  if (!pending || hasEquivalentLatestUserMessage(messages, pending)) {
    return messages;
  }
  return [...messages, pending];
}

function hasEquivalentLatestUserMessage(
  messages: Message[],
  pending: Message,
): boolean {
  // Content equality is not an acknowledgement: two consecutive prompts can
  // intentionally contain the same text. Only the client message id proves
  // that the canonical transcript contains this pending submission.
  return messages.some((message) => message.id === pending.id);
}

function extractMessageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  const unknownContent: unknown = content;
  if (!Array.isArray(unknownContent)) {
    return "";
  }
  return unknownContent
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
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

function summarizeMessageRoles(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([role, count]) => `${role}:${count}`)
    .join(",");
}

function summarizeMessageIdentities(messages: Message[]): string {
  return messages
    .map(
      (message) =>
        `${message.role}:${message.id}:${hashLogString(extractMessageText(message.content))}`,
    )
    .join(",");
}
