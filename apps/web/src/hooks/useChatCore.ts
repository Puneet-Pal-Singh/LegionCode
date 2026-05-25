import { useChat as useVercelChat, type Message } from "@ai-sdk/react";
import {
  DEFAULT_RUN_MODE,
  type ProductMode,
  type RunMode,
} from "@repo/shared-types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { chatStreamPath, getBrainHttpBase } from "../lib/platform-endpoints.js";
import { dispatchRunSummaryRefresh } from "../lib/run-summary-events.js";
import { agentStore } from "../store/agentStore";
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
import { loadRepositoryContextFields } from "../lib/chat-repository-context";

interface UseChatCoreResult {
  messages: Message[];
  input: string;
  handleInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (e?: FormEvent) => void;
  append: (message: { role: "user"; content: string }) => Promise<void>;
  isLoading: boolean;
  stop: () => void;
  setMessages: (messages: Message[]) => void;
  runId: string;
  resetRun: () => void;
  isModelConfigReady: boolean;
  error: string | null;
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
    crypto.randomUUID(),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [debugEvents, setDebugEvents] = useState<ChatDebugEvent[]>([]);
  const lastLoggedStreamErrorRef = useRef<{
    message: string;
    timestamp: number;
  } | null>(null);
  const runId = externalRunId || internalRunId;
  const apiPath = chatStreamPath();
  const scopeKey = `${sessionId}:${runId}`;
  const activeScopeKeyRef = useRef(scopeKey);
  const clearedScopeRef = useRef<string | null>(null);
  const isActiveScope = useCallback(
    (candidateScopeKey: string) =>
      activeScopeKeyRef.current === candidateScopeKey,
    [],
  );

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    setError(null);
    setIsSubmitting(false);
    setIsStopping(false);
    setDebugEvents([]);
    lastLoggedStreamErrorRef.current = null;
  }, [scopeKey]);

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

  // Stable instance key - changes when runId changes
  const instanceKey = useMemo(() => `chat-${runId}`, [runId]);
  const {
    status,
    credentials,
    selectedProviderId,
    selectedCredentialId,
    selectedModelId,
    lastResolvedConfig,
    resolveForChat,
  } = useProviderStore(runId);
  const authenticatedChatFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithSessionAuth(input, init),
    [],
  );
  const hasConnectedCredential = credentials.length > 0;
  const isModelConfigReady = status === "ready" && hasConnectedCredential;

  const {
    messages,
    input,
    handleInputChange,
    isLoading,
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
    },
    initialMessages: [],
    id: instanceKey,
    onResponse: (response: Response) => {
      if (!isActiveScope(scopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
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
      if (!isActiveScope(scopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
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
      if (!isActiveScope(scopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
      const message = normalizeChatErrorMessage(error);
      setError(message);
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

  useLayoutEffect(() => {
    if (clearedScopeRef.current === scopeKey) return;
    clearedScopeRef.current = scopeKey;
    setMessages(agentStore.getMessages(runId));
  }, [runId, scopeKey, setMessages]);

  const resetRun = useCallback(() => {
    if (!externalRunId) {
      setInternalRunId(crypto.randomUUID());
    }
    // setMessages will be called after the new instance is created via instanceKey change
  }, [externalRunId]);

  const resolveSelectedProviderConfigForRequest = useCallback(
    (): ResolvedProviderConfig | null =>
      resolveSelectedProviderConfig({
        selectedProviderId,
        selectedModelId,
        selectedCredentialId,
        lastResolvedConfig,
      }),
    [
      lastResolvedConfig,
      selectedCredentialId,
      selectedModelId,
      selectedProviderId,
    ],
  );

  const resolveProviderConfigFromApi = useCallback(
    async (requestScopeKey: string): Promise<ResolvedProviderConfig | null> => {
      const resolvedConfig = await resolveForChat();
      if (!isActiveScope(requestScopeKey)) {
        return null;
      }

      return requireResolvedProviderConfig({
        providerId: resolvedConfig.providerId,
        modelId: resolvedConfig.modelId,
        credentialId: resolvedConfig.credentialId,
        source: "provider_resolve_api",
      });
    },
    [isActiveScope, resolveForChat],
  );

  const buildChatRequestBody = useCallback(
    (config: ResolvedProviderConfig): ChatRequestBody =>
      parseChatRequestBody({
        sessionId,
        runId,
        mode,
        productMode,
        harnessId: resolveRuntimeHarnessId(sessionId),
        providerId: config.providerId,
        modelId: config.modelId,
        ...loadRepositoryContextFields(sessionId),
      }),
    [mode, productMode, runId, sessionId],
  );

  const pushChatRequestDebugEvent = useCallback(
    (
      content: string,
      requestBody: ChatRequestBody,
      config: ResolvedProviderConfig,
    ) => {
      pushDebugEvent({
        phase: "request",
        summary: `POST ${apiPath}`,
        payload: {
          endpoint: apiPath,
          requestBody,
          userMessage: content,
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
    async (content: string, requestBody: ChatRequestBody): Promise<void> => {
      await append(
        { role: "user", content },
        {
          body: requestBody,
        },
      );
    },
    [append],
  );

  const appendWithResolution = useCallback(
    async (message: { role: "user"; content: string }): Promise<void> => {
      const requestScopeKey = scopeKey;
      const content = message.content.trim();
      if (!content || status !== "ready") {
        throw new Error(
          "Chat is still initializing model settings. Wait a moment, then try again. If this continues, open Settings and reconnect a provider key.",
        );
      }
      setError(null);
      setIsSubmitting(true);
      setIsStopping(false);
      dispatchRunSummaryRefresh(runId);

      try {
        const providerConfig =
          resolveSelectedProviderConfigForRequest() ??
          (await resolveProviderConfigFromApi(requestScopeKey));
        if (!providerConfig) return;
        if (!isActiveScope(requestScopeKey)) {
          return;
        }

        const requestBody = buildChatRequestBody(providerConfig);
        pushChatRequestDebugEvent(content, requestBody, providerConfig);
        dispatchRunSummaryRefresh(runId);
        await submitResolvedMessage(content, requestBody);
      } finally {
        if (isActiveScope(requestScopeKey)) {
          setIsSubmitting(false);
        }
      }
    },
    [
      buildChatRequestBody,
      isActiveScope,
      pushChatRequestDebugEvent,
      resolveProviderConfigFromApi,
      resolveSelectedProviderConfigForRequest,
      runId,
      scopeKey,
      status,
      submitResolvedMessage,
    ],
  );

  const shouldBlockSubmit = useCallback(
    (content: string) =>
      !content ||
      isLoading ||
      isSubmitting ||
      isStopping ||
      !isModelConfigReady,
    [isLoading, isModelConfigReady, isStopping, isSubmitting],
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
      if (!isActiveScope(requestScopeKey)) {
        return;
      }
      restoreChatInput(originalInput);
      const message =
        error instanceof Error
          ? normalizeChatErrorMessage(error)
          : "Failed to send message.";
      setError(message);
      pushDebugEvent({
        phase: "error",
        summary: message,
        payload: {
          source: "appendWithResolution",
          error: error instanceof Error ? error.message : "Unknown append error",
        },
      });
      console.error(
        `[useChatCore] Failed to append resolved message for session ${sessionId}`,
        error,
      );
    },
    [isActiveScope, pushDebugEvent, restoreChatInput, sessionId],
  );

  const submitPreparedInput = useCallback(
    async (
      content: string,
      requestScopeKey: string,
      originalInput: string,
    ): Promise<void> => {
      try {
        await appendWithResolution({ role: "user", content });
      } catch (error) {
        handleSubmitFailure(error, requestScopeKey, originalInput);
      }
    },
    [appendWithResolution, handleSubmitFailure],
  );

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const requestScopeKey = scopeKey;
      const originalInput = input;
      const trimmedInput = input.trim();
      if (shouldBlockSubmit(trimmedInput)) {
        return;
      }
      clearChatInput();
      void submitPreparedInput(trimmedInput, requestScopeKey, originalInput);
    },
    [
      clearChatInput,
      input,
      scopeKey,
      shouldBlockSubmit,
      submitPreparedInput,
    ],
  );

  const stop = useCallback(() => {
    const requestRunId = runId;
    const requestScopeKey = scopeKey;
    setIsSubmitting(false);
    setIsStopping(true);
    stopStream();
    dispatchRunSummaryRefresh(requestRunId);

    const cancelRun = async (): Promise<void> => {
      try {
        const response = await authenticatedChatFetch(
          `${getBrainHttpBase()}/api/run/cancel`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ runId: requestRunId }),
          },
        );
        if (!response.ok) {
          throw new Error(`Cancel failed with HTTP ${response.status}`);
        }
        dispatchRunSummaryRefresh(requestRunId);
      } catch (error) {
        console.warn("[chat/stop] Failed to cancel run", {
          runId: requestRunId,
          error,
        });
      } finally {
        if (isActiveScope(requestScopeKey)) {
          setIsStopping(false);
        }
      }
    };

    void cancelRun();
  }, [authenticatedChatFetch, isActiveScope, runId, scopeKey, stopStream]);

  return {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append: appendWithResolution,
    isLoading: isLoading || isSubmitting || isStopping,
    stop,
    setMessages,
    runId,
    resetRun,
    isModelConfigReady,
    error,
    debugEvents,
  };
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
