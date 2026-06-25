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
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";
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
import {
  toImageParts,
  toRedactedImageMetadata,
  type ChatImageAttachment,
} from "../components/chat/chatImageAttachments";

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
      logClientEvent("chat/stream", "response", {
        runId,
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
      if (!isActiveScope(scopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
      logClientEvent("chat/stream", "finished", {
        runId,
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
      if (!isActiveScope(scopeKey)) {
        return;
      }
      dispatchRunSummaryRefresh(runId);
      const message = normalizeChatErrorMessage(error);
      setError(message);
      logClientWarning("chat/stream", "failed", {
        runId,
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
  const messagesReadyScopeKeyRef = useRef(scopeKey);
  const pendingScopeMessagesRef = useRef<{
    scopeKey: string;
    messages: Message[];
  } | null>(null);
  const [, setMessagesScopeVersion] = useState(0);
  const scopedMessages =
    messagesReadyScopeKeyRef.current === scopeKey
      ? messages
      : (pendingScopeMessagesRef.current?.messages ??
        agentStore.getMessages(runId));

  useLayoutEffect(() => {
    if (clearedScopeRef.current === scopeKey) return;
    clearedScopeRef.current = scopeKey;
    const scopedStoredMessages = agentStore.getMessages(runId);
    messagesReadyScopeKeyRef.current = "";
    pendingScopeMessagesRef.current = {
      scopeKey,
      messages: scopedStoredMessages,
    };
    setMessages(scopedStoredMessages);
    setMessagesScopeVersion((version) => version + 1);
  }, [runId, scopeKey, setMessages]);

  useEffect(() => {
    const pendingScope = pendingScopeMessagesRef.current;
    if (
      !pendingScope ||
      pendingScope.scopeKey !== scopeKey ||
      !haveSameMessageIds(messages, pendingScope.messages)
    ) {
      return;
    }

    pendingScopeMessagesRef.current = null;
    messagesReadyScopeKeyRef.current = scopeKey;
    setMessagesScopeVersion((version) => version + 1);
  }, [messages, scopeKey]);

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
          userMessage: text,
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
      await appendMultimodal(message, { body: requestBody });
    },
    [append],
  );

  const appendWithResolution = useCallback(
    async (message: ChatAppendMessage): Promise<void> => {
      const requestScopeKey = scopeKey;
      const content = extractTextContent(message.content).trim();
      const hasImages = messageHasImageParts(message);
      if ((!content && !hasImages) || status !== "ready") {
        throw new Error(
          "Chat is still initializing model settings. Wait a moment, then try again. If this continues, open Settings and reconnect a provider key.",
        );
      }
      setError(null);
      setIsSubmitting(true);
      setIsStopping(false);
      logClientEvent("chat/submit", "started", {
        runId,
        sessionId,
        hasText: Boolean(content),
        imageCount: message.imageMetadata?.length ?? 0,
      });
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
        logClientEvent("chat/submit", "provider-resolved", {
          runId,
          providerId: providerConfig.providerId,
          modelId: providerConfig.modelId,
          source: providerConfig.source,
        });
        pushChatRequestDebugEvent(message, requestBody, providerConfig);
        dispatchRunSummaryRefresh(runId);
        await submitResolvedMessage(message, requestBody);
      } finally {
        if (isActiveScope(requestScopeKey)) {
          setIsSubmitting(false);
          logClientEvent("chat/submit", "settled", { runId });
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
      sessionId,
      scopeKey,
      status,
      submitResolvedMessage,
    ],
  );

  const shouldBlockSubmit = useCallback(
    (content: string, hasImages: boolean) =>
      (!content && !hasImages) ||
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
          error:
            error instanceof Error ? error.message : "Unknown append error",
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
      const requestScopeKey = scopeKey;
      const originalInput = input;
      const trimmedInput = input.trim();
      const imageAttachments = attachments?.imageAttachments ?? [];
      if (shouldBlockSubmit(trimmedInput, imageAttachments.length > 0)) {
        return false;
      }
      clearChatInput();
      return submitPreparedInput(
        buildChatAppendMessage(trimmedInput, imageAttachments),
        requestScopeKey,
        originalInput,
      );
    },
    [clearChatInput, input, scopeKey, shouldBlockSubmit, submitPreparedInput],
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
    messages: scopedMessages,
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

function haveSameMessageIds(left: Message[], right: Message[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => message.id === right[index]?.id)
  );
}
