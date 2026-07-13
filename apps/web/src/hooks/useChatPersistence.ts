import { useEffect, useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { ChatPersistenceService } from "../services/ChatPersistenceService";
import type { ConversationScope } from "./conversationScope";

interface UseChatPersistenceProps {
  scope: ConversationScope | null;
  messages: Message[];
}

/**
 * useChatPersistence
 * Mirrors canonical messages into the UI store.
 */
export function useChatPersistence({
  scope,
  messages,
}: UseChatPersistenceProps): void {
  const persistenceService = useMemo(() => new ChatPersistenceService(), []);

  useEffect(() => {
    if (!scope) {
      return;
    }
    persistenceService.syncToStore(scope, messages);
  }, [messages, scope, persistenceService]);
}
