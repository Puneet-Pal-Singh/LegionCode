import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import type { HostedSessionWorkspaceContext } from "@legioncode/sdk";
import { useChat, type UseChatResult } from "../../hooks/useChat";
import { resolveHydratedChatImageSource } from "../chat/chatMessageImagePresentation";
import {
  projectSavedChatSources,
  type SavedChatSourcesProjection,
} from "../../lib/saved-chat-sources";
import {
  loadStoredProductMode,
  persistProductMode,
} from "../../lib/product-mode-storage";

export interface SessionConversationSurfaceContext {
  chat: UseChatResult;
  productMode: ProductMode;
  setProductMode: (mode: ProductMode) => void;
  savedSources: SavedChatSourcesProjection;
  showWorkspace: boolean;
  registerFileCreatedRefresh: (callback: (() => void) | null) => void;
}

interface SessionConversationSurfaceProps {
  sessionId: string;
  runId?: string;
  mode?: RunMode;
  onServerProjectionAvailable?: () => void;
  onSavedSourcesChange?: (projection: SavedChatSourcesProjection) => void;
  onRunIdChange?: (runId: string) => void;
  workspaceContext?: HostedSessionWorkspaceContext | null;
  isSessionPersistenceReady: boolean;
  hasQueuedIntent: boolean;
  children: (context: SessionConversationSurfaceContext) => ReactNode;
}

/** One transcript and history owner for the lifetime of a saved session. */
export function SessionConversationSurface({
  sessionId,
  runId,
  mode,
  onServerProjectionAvailable,
  onSavedSourcesChange,
  onRunIdChange,
  workspaceContext,
  isSessionPersistenceReady,
  hasQueuedIntent,
  children,
}: SessionConversationSurfaceProps) {
  const [productMode, setProductMode] = useState<ProductMode>(() =>
    loadStoredProductMode(sessionId),
  );
  const [fileCreatedRefresh, setFileCreatedRefresh] = useState<
    (() => void) | null
  >(null);
  const registerFileCreatedRefresh = useCallback(
    (callback: (() => void) | null) => {
      setFileCreatedRefresh(() => callback);
    },
    [setFileCreatedRefresh],
  );
  const refreshCreatedFile = useCallback(
    () => fileCreatedRefresh?.(),
    [fileCreatedRefresh],
  );
  useEffect(
    () => persistProductMode(sessionId, productMode),
    [productMode, sessionId],
  );

  const chat = useChat(
    sessionId,
    runId,
    refreshCreatedFile,
    mode,
    productMode,
    onServerProjectionAvailable,
    isSessionPersistenceReady,
    onRunIdChange,
    workspaceContext,
  );
  const savedSources = useMemo(
    () =>
      projectSavedChatSources({
        messages: chat.messages,
        restoredUserMessageIds: chat.restoredUserMessageIds,
        hydrationStatus: chat.hydrationStatus,
        isHydrating: chat.isHydrating,
        hasHydrated: chat.hasHydrated,
        hydrationError: chat.hydrationError,
        resolveImageSource: resolveHydratedChatImageSource,
      }),
    [
      chat.hydrationError,
      chat.hydrationStatus,
      chat.hasHydrated,
      chat.isHydrating,
      chat.messages,
      chat.restoredUserMessageIds,
    ],
  );
  useEffect(() => {
    onSavedSourcesChange?.(savedSources);
  }, [onSavedSourcesChange, savedSources]);
  const showWorkspace =
    isSessionPersistenceReady &&
    (hasQueuedIntent ||
      chat.isLoading ||
      chat.activeTurnProjection.isActive ||
      chat.activeTurnProjection.isTransportPending ||
      Boolean(chat.error) ||
      !chat.hasHydrated ||
      chat.hydrationStatus !== "empty" ||
      chat.messages.length > 0);

  return children({
    chat,
    productMode,
    setProductMode,
    savedSources,
    showWorkspace,
    registerFileCreatedRefresh,
  });
}
