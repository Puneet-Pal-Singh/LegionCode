import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ProductMode, RunMode } from "@repo/shared-types";
import { useChat, type UseChatResult } from "../../hooks/useChat";
import {
  loadStoredProductMode,
  persistProductMode,
} from "../../lib/product-mode-storage";

export interface SessionConversationSurfaceContext {
  chat: UseChatResult;
  productMode: ProductMode;
  setProductMode: (mode: ProductMode) => void;
  showWorkspace: boolean;
  registerFileCreatedRefresh: (callback: (() => void) | null) => void;
}

interface SessionConversationSurfaceProps {
  sessionId: string;
  runId?: string;
  mode?: RunMode;
  onServerProjectionAvailable?: () => void;
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
  );
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
    showWorkspace,
    registerFileCreatedRefresh,
  });
}
