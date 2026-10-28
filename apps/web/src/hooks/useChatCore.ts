import { useChat as useVercelChat, type Message } from "@ai-sdk/react";
import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  submitConversationMessage,
  type SubmissionAttempt,
  type SubmissionOutcome,
  type PlatformClient,
  type LifecycleEvent,
} from "@legioncode/sdk";
import type { HostedSessionWorkspaceContext } from "@legioncode/sdk";
import {
  DEFAULT_RUN_MODE,
  RunModeSchema,
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
  type ResolvedProviderConfig,
} from "../lib/chat-provider-config";
import {
  parseChatRequestBody,
  resolveRuntimeHarnessId,
  type ChatRequestBody,
} from "../lib/chat-request";
import { resolveReasoningEffortForRequest } from "../lib/model-reasoning-preferences";
import { loadSessionBranchPreference } from "../lib/session-branch-preference";
import {
  toImageParts,
  toRedactedImageMetadata,
  type ChatImageAttachment,
} from "@legioncode/client-ui";
import { createRunId } from "../lib/run-id";
import {
  bootstrapConversationScope,
  conversationScopeKey,
  isEstablishedRunScope,
  isTurnScopeRecoveryError,
  publishConversationScopeReady,
  resumeConversationScope,
} from "./conversationScope";
import { ConversationScopeHttpError, type ConversationScope } from "@legioncode/sdk";
import { createWebPlatformClient } from "../services/api/platformClient";
import { useConversationInputCommands } from "./chat/useConversationInputCommands";
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
  submitFollowUp: (
    text: string,
    attachments: ChatSubmitAttachments | undefined,
    delivery: "queue" | "steer",
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
  resumeInterruptedTurn: (expectedTerminalSequence: number) => Promise<boolean>;
  applyStartedQueueReceipt: (
    receipt: Extract<
      import("@legioncode/sdk").ThreadInputReceipt,
      { status: "started" }
    >,
    expectedScope: ConversationScope,
  ) => boolean;
  error: string | null;
  scopeRecoveryError: ConversationScopeHttpError | null;
  retryScopeRead: () => Promise<void>;
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
  onRunIdChange?: (runId: string) => void,
  workspaceContext?: HostedSessionWorkspaceContext | null,
): UseChatCoreResult {
  const isWorkspaceExecutionAllowed = Boolean(
    workspaceContext?.sessionId === sessionId &&
    workspaceContext.workspaceStatus !== "archived",
  );
  const [internalRunId, setInternalRunId] = useState<string>(() =>
    createRunId(),
  );
  const [error, setError] = useState<string | null>(null);
  const [scopeRecoveryError, setScopeRecoveryError] =
    useState<ConversationScopeHttpError | null>(null);
  const scopeRecoveryErrorRef = useRef(scopeRecoveryError);
  scopeRecoveryErrorRef.current = scopeRecoveryError;
  const errorRef = useRef(error);
  errorRef.current = error;
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
  const composerInputVersionRef = useRef(0);
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
    setScopeRecoveryError(null);
    setIsSubmitting(false);
    setIsStopping(false);
    setOptimisticUserMessageId(null);
    setDebugEvents([]);
    lastLoggedStreamErrorRef.current = null;
  }, [runScopeKey]);

  const refreshConversationScope = useCallback(
    async (manual: boolean, signal?: AbortSignal): Promise<void> => {
      const normalizedSessionId = sessionId.trim();
      const normalizedRunId = runId.trim();
      const requestedRunScopeKey = `${encodeURIComponent(normalizedSessionId)}:${encodeURIComponent(normalizedRunId)}`;
      if (!normalizedSessionId || !normalizedRunId) return;
      const originatingError = errorRef.current;
      const originatingScopeError = scopeRecoveryErrorRef.current;
      const requestGeneration = runScopeGenerationRef.current;
      const requestScopeKey = activeScopeKeyRef.current;
      const requestSubmissionToken =
        activeSubmissionAttemptRef.current?.token ?? null;
      const ownsScopeRead = () =>
        !signal?.aborted &&
        isActiveRunScope(requestedRunScopeKey) &&
        runScopeGenerationRef.current === requestGeneration &&
        activeScopeKeyRef.current === requestScopeKey &&
        (activeSubmissionAttemptRef.current?.token ?? null) ===
          requestSubmissionToken;
      try {
        const scope = await resumeConversationScope(
          normalizedSessionId,
          normalizedRunId,
          signal,
        );
        if (!ownsScopeRead()) return;
        if (!scope) {
          if (!manual) return;
          const missingScope = new ConversationScopeHttpError({
            status: 404,
            code: "TURN_SCOPE_NOT_FOUND",
            message: "No saved turn was found for this conversation.",
            retryable: false,
          });
          setScopeRecoveryError((current) =>
            current === originatingScopeError || current === null
              ? missingScope
              : current,
          );
          setError((current) =>
            current === originatingError || current === null
              ? missingScope.message
              : current,
          );
          return;
        }
        activeScopeKeyRef.current = conversationScopeKey(scope);
        activeConversationScopeRef.current = scope;
        setConversationScope(scope);
        setError((current) => (current === originatingError ? null : current));
        setScopeRecoveryError((current) =>
          current === originatingScopeError ? null : current,
        );
        publishConversationScopeReady(scope);
      } catch (error: unknown) {
        if (!ownsScopeRead()) return;
        if (
          !manual &&
          isEstablishedRunScope(
            activeConversationScopeRef.current,
            normalizedSessionId,
            normalizedRunId,
          )
        ) {
          return;
        }
        const scopeError =
          error instanceof ConversationScopeHttpError
            ? error
            : new ConversationScopeHttpError({
                status: 0,
                code: "TURN_SCOPE_READ_FAILED",
                message: "Could not read the saved conversation status.",
                retryable: true,
              });
        setScopeRecoveryError((current) =>
          current === originatingScopeError || current === null
            ? scopeError
            : current,
        );
        setError((current) =>
          current === originatingError || current === null
            ? scopeError.message
            : current,
        );
        logClientWarning("chat/scope", "reconstruction-failed", {
          runId: normalizedRunId,
          sessionId: normalizedSessionId,
          code: scopeError.code,
          status: scopeError.status,
          retryable: scopeError.retryable,
        });
      }
    },
    [isActiveRunScope, runId, sessionId],
  );

  useEffect(() => {
    if (!sessionId.trim() || !externalRunId?.trim()) {
      setConversationScope(null);
      return;
    }
    const controller = new AbortController();
    void refreshConversationScope(false, controller.signal);
    return () => controller.abort();
  }, [externalRunId, refreshConversationScope, runScopeKey, sessionId]);

  const retryScopeRead = useCallback(
    () => refreshConversationScope(true),
    [refreshConversationScope],
  );

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
    providerModels,
    manageProviderModels,
    resolveForChat,
  } = useProviderStore(runId, sessionId);
  const selectedModel =
    selectedProviderId && selectedModelId
      ? (providerModels[selectedProviderId]?.find(
          (model) => model.id === selectedModelId,
        ) ??
        manageProviderModels[selectedProviderId]?.find(
          (model) => model.id === selectedModelId,
        ))
      : undefined;
  const selectedModelEfforts = selectedModel?.capabilities?.reasoningEfforts;
  const authenticatedChatFetch = useMemo(
    () => createSubmissionObservedFetch(fetchWithSessionAuth),
    [],
  );
  const hasConnectedCredential = credentials.length > 0;
  const isModelConfigReady = status === "ready" && hasConnectedCredential;
  const lifecycleClient = useMemo(() => createWebPlatformClient(), []);

  const {
    input,
    handleInputChange: updateInput,
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
              ...(activeConversationScope.continuationOfTurnId
                ? {
                    continuationOfTurnId:
                      activeConversationScope.continuationOfTurnId,
                    originalPromptId: activeConversationScope.originalPromptId,
                  }
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

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      composerInputVersionRef.current += 1;
      updateInput(event);
    },
    [updateInput],
  );

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
      repositoryFields: Pick<ChatRequestBody, "repositoryOwner" | "repositoryName" | "repositoryBranch" | "repositoryBaseUrl">,
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
        ...repositoryFields,
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
      if (!isWorkspaceExecutionAllowed) {
        return {
          status: "unconfirmed",
          message: "This conversation's workspace is unavailable for new work.",
        };
      }
      if ((!content && !hasImages) || status !== "ready") {
        return {
          status: "unconfirmed",
          message:
            "Chat is still establishing its server-owned turn scope or model settings. Wait a moment, then try again.",
        };
      }
      if (!RunModeSchema.safeParse(mode).success) {
        return {
          status: "unconfirmed",
          message:
            "This chat has an unsupported run mode. Choose Build or Plan before submitting.",
        };
      }
      const intentKey = message.id
        ? `explicit:${message.id}`
        : revisionTarget
          ? `revision:${revisionTarget}`
          : "composer";
      const repositoryFields = workspaceContext?.sessionId === sessionId &&
        workspaceContext.workspaceStatus !== "archived" &&
        workspaceContext.repository
        ? {
            repositoryOwner: workspaceContext.repository.owner,
            repositoryName: workspaceContext.repository.name,
            repositoryBranch: loadSessionBranchPreference(sessionId, workspaceContext.repository.fullName) ?? workspaceContext.selectedBranch ?? undefined,
            repositoryBaseUrl: workspaceContext.repository.repoUrl,
          }
        : {};
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
        repository: repositoryFields,
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

      const submissionBinding: { attempt: SubmissionAttempt | null } = {
        attempt: null,
      };
      let submittedMessage: (ChatAppendMessage & { id: string }) | null = null;

      try {
        const outcome = await submitConversationMessage<ResolvedProviderConfig>({
          sessionId,
          runId,
          runScopeGeneration: bootstrapScopeGeneration,
          clientMessageId: message.id,
          intentKey,
          intentFingerprint,
          lifecycleClient,
          resolveProviderConfig: async () => {
            const config = await resolveProviderConfigFromApi(bootstrapScopeKey);
            if (!config) {
              logClientWarning("chat/submit", "aborted", {
                runId,
                sessionId,
                scopeKey: bootstrapScopeKey,
                reason: "provider-resolution-unavailable",
              });
            }
            return config;
          },
          onAttemptAcquired: (attempt) => {
            submissionBinding.attempt = attempt;
            submittedMessage = ensureClientMessageId({
              ...message,
              id: attempt.clientMessageId,
            });
            retainedSubmissionScopeRef.current = attempt.scope;
            activeSubmissionAttemptRef.current = attempt;
            setError(null);
            setScopeRecoveryError(null);
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
            setOptimisticUserMessageId(submittedMessage.id);
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
          },
          reserveScope: async (attempt) => {
            try {
              return await bootstrapConversationScope(
                sessionId,
                attempt.originalRunId,
                attempt.clientMessageId,
                revisionTarget,
              );
            } catch (error) {
              if (
                !attempt.stopRequested &&
                activeSubmissionAttemptRef.current?.token === attempt.token &&
                ownsInvocationScope()
              ) {
                setScopeRecoveryError(
                  error instanceof ConversationScopeHttpError ? error : null,
                );
              }
              throw error;
            }
          },
          onReserved: (scope) => {
            if (!ownsInvocationScope() || !submittedMessage) return false;
            retainedSubmissionScopeRef.current = scope;
            const requestScopeKey = conversationScopeKey(scope);
            activeScopeKeyRef.current = requestScopeKey;
            activeConversationScopeRef.current = scope;
            setConversationScope(scope);
            setError((current) =>
              isTurnScopeRecoveryError(current) ? null : current,
            );
            publishConversationScopeReady(scope);
            setPendingUserMessage({
              scopeKey: requestScopeKey,
              message: buildPendingUserMessage(submittedMessage, scope),
            });
            return true;
          },
          isStopPending: () =>
            stopRequestedRef.current &&
            preAdmissionStopKeyRef.current === bootstrapScopeKey,
          isInvocationActive: ownsInvocationScope,
          onInactiveScopeAfterProviderResolution: () => {
            logClientWarning("chat/submit", "aborted", {
              runId,
              sessionId,
              scopeKey: bootstrapScopeKey,
              reason: "inactive-scope-after-provider-resolution",
            });
          },
          dispatch: async ({ config, scope, clientMessageId }) => {
            const dispatchedMessage = ensureClientMessageId({
              ...message,
              id: clientMessageId,
            });
            const requestBody = buildChatRequestBody(
              config,
              clientMessageId,
              scope,
              repositoryFields,
            );
            logClientEvent("chat/submit", "provider-resolved", {
              runId,
              sessionId,
              scopeKey: conversationScopeKey(scope),
              clientMessageId,
              providerId: config.providerId,
              modelId: config.modelId,
              source: config.source,
            });
            pushChatRequestDebugEvent(dispatchedMessage, requestBody, config);
            dispatchRunSummaryRefresh(runId);
            await submitResolvedMessage(dispatchedMessage, requestBody);
          },
          interruptAcceptedTurn: async (attempt, scope) => {
            const ownsSubmissionAttempt = () =>
              activeSubmissionAttemptRef.current?.token === attempt.token &&
              ownsInvocationScope();
            try {
              await interruptAndAwaitTerminal(
                lifecycleClient,
                scope,
                () => {
                  if (ownsSubmissionAttempt()) stopStream();
                },
              );
            } catch (interruptError) {
              if (ownsSubmissionAttempt()) {
                stopRequestedRef.current = false;
                setIsStopping(false);
                setError(
                  "Stop not confirmed yet. Check status or try Stop again.",
                );
              }
              logClientWarning(
                "chat/stop",
                "accepted-turn-interrupt-unsettled",
                {
                  runId: scope.runId,
                  sessionId: scope.sessionId,
                  scopeKey: conversationScopeKey(scope),
                  error:
                    interruptError instanceof Error
                      ? interruptError.message
                      : String(interruptError),
                },
              );
            }
          },
          interruptUnconfirmedTurn: async (attempt, scope) => {
            try {
              await interruptAndAwaitTerminal(
                lifecycleClient,
                scope,
                () => {
                  if (
                    activeSubmissionAttemptRef.current?.token ===
                      attempt.token &&
                    ownsInvocationScope()
                  ) {
                    stopStream();
                  }
                },
              );
              return true;
            } catch (interruptError) {
              logClientWarning("chat/stop", "uncertain-interrupt-failed", {
                runId: scope.runId,
                sessionId: scope.sessionId,
                scopeKey: conversationScopeKey(scope),
                error:
                  interruptError instanceof Error
                    ? interruptError.message
                    : String(interruptError),
              });
              return false;
            }
          },
          onReservationCancelled: (attempt) => {
            if (
              activeSubmissionAttemptRef.current?.token !== attempt.token ||
              !ownsInvocationScope()
            ) {
              return;
            }
            retainedSubmissionScopeRef.current = null;
            setConversationScope(null);
            activeConversationScopeRef.current = null;
            activeScopeKeyRef.current = bootstrapScopeKey;
            setPendingUserMessage(null);
            setOptimisticUserMessageId(null);
          },
        });

        const settledAttempt = submissionBinding.attempt;
        const ownsSettledAttempt =
          settledAttempt !== null &&
          activeSubmissionAttemptRef.current?.token === settledAttempt.token &&
          ownsInvocationScope();
        if (outcome.status === "accepted") {
          if (ownsSettledAttempt) setError(null);
        } else if (
          outcome.status === "unconfirmed" ||
          (outcome.status === "cancelled" &&
            outcome.admission === "unconfirmed")
        ) {
          if (ownsSettledAttempt) {
            retainedSubmissionScopeRef.current = null;
            setConversationScope(null);
            activeConversationScopeRef.current = null;
            activeScopeKeyRef.current = bootstrapScopeKey;
            if (outcome.status === "unconfirmed") setError(outcome.message);
            setPendingUserMessage(null);
            setOptimisticUserMessageId(null);
          }
        }
        return outcome;
      } finally {
        const settledAttempt = submissionBinding.attempt;
        const ownsSettlement =
          settledAttempt !== null &&
          activeSubmissionAttemptRef.current?.token === settledAttempt.token;
        if (ownsSettlement) {
          activeSubmissionAttemptRef.current = null;
        }
        if (ownsSettlement && settledAttempt !== null && ownsInvocationScope()) {
          setIsSubmitting(false);
          logClientEvent("chat/submit", "settled", {
            runId,
            sessionId,
            scopeKey: activeScopeKeyRef.current,
            clientMessageId: settledAttempt.clientMessageId,
          });
        }
      }
    },
    [
      buildChatRequestBody,
      isWorkspaceExecutionAllowed,
      isActiveRunScope,
      lifecycleClient,
      mode,
      productMode,
      pushChatRequestDebugEvent,
      resolveProviderConfigFromApi,
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
      workspaceContext,
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
  const commitConversationScope = useCallback((scope: ConversationScope) => {
    activeScopeKeyRef.current = conversationScopeKey(scope);
    activeConversationScopeRef.current = scope;
    setConversationScope(scope);
  }, []);
  const { submitFollowUp: submitFollowUpCommand, resumeInterruptedTurn: resumeInterruptedTurnCommand, applyStartedQueueReceipt } =
    useConversationInputCommands({
      sessionId,
      runId,
      onRunIdChange,
      mode,
      productMode,
      selectedProviderId,
      selectedModelId,
      selectedModelEfforts,
      lifecycleClient,
      scopeRef: activeConversationScopeRef,
      runScopeRef: activeRunScopeKeyRef,
      generationRef: runScopeGenerationRef,
      isActiveRunInvocation,
      clearInput: clearChatInput,
      latestInputRef: latestComposerInputRef,
      inputVersionRef: composerInputVersionRef,
      setError,
      commitScope: commitConversationScope,
    });
  const submitFollowUp = useCallback((text: string, attachments: ChatSubmitAttachments | undefined, delivery: "queue" | "steer") => {
    if (!isWorkspaceExecutionAllowed) {
      setError("This conversation's workspace is unavailable for new work.");
      return Promise.resolve(false);
    }
    return submitFollowUpCommand(text, attachments, delivery);
  }, [isWorkspaceExecutionAllowed, submitFollowUpCommand]);
  const resumeInterruptedTurn = useCallback((expectedTerminalSequence: number) => {
    if (!isWorkspaceExecutionAllowed) {
      setError("This conversation's workspace is unavailable for new work.");
      return Promise.resolve(false);
    }
    return resumeInterruptedTurnCommand(expectedTerminalSequence);
  }, [isWorkspaceExecutionAllowed, resumeInterruptedTurnCommand]);

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
      if (!isWorkspaceExecutionAllowed) {
        setError("This conversation's workspace is unavailable for new work.");
        return false;
      }
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
      isWorkspaceExecutionAllowed,
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
          await interruptAndAwaitTerminal(lifecycleClient, requestScope, () => {
            if (stopOwnsInvocation()) stopStream();
          });
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
          setError("Stop not confirmed yet. Check status or try Stop again.");
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
    submitFollowUp,
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
    scopeRecoveryError,
    retryScopeRead,
    clearNonCanonicalError,
    debugEvents,
    reviseTurn,
    resumeInterruptedTurn,
    applyStartedQueueReceipt,
  };
}

export async function interruptAndAwaitTerminal(
  lifecycleClient: Pick<PlatformClient, "interruptTurn" | "followTurnLifecycle">,
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
    LifecycleEvent
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

async function requestExactInterrupt(
  lifecycleClient: Pick<PlatformClient, "interruptTurn">,
  scope: ConversationScope,
  signal: AbortSignal,
): Promise<import("@legioncode/sdk").InterruptTurnResponse> {
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
  if (
    !response.accepted &&
    !isExactTerminalEvent(response.terminalEvent, scope)
  ) {
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

function isExactTerminalEvent(
  event: import("@legioncode/sdk").LifecycleEvent | null | undefined,
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
