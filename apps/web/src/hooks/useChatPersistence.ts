import { useEffect, useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatPersistenceService } from "../services/ChatPersistenceService";

interface UseChatPersistenceProps {
  runId: string;
  messages: Message[];
}

/**
 * useChatPersistence
 * Mirrors canonical messages into the UI store.
 */
export function useChatPersistence({
  runId,
  messages,
}: UseChatPersistenceProps): void {
  const persistenceService = useMemo(() => new ChatPersistenceService(), []);

  useEffect(() => {
    persistenceService.syncToStore(runId, messages);
  }, [messages, runId, persistenceService]);
}
