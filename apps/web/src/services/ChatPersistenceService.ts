/**
 * ChatPersistenceService
 * Manages chat message persistence and retrieval
 *
 * Single Responsibility: Mirror canonical chat messages into the in-memory
 * UI store. Prompt submission and replay are owned by the canonical request
 * lifecycle; browser storage must not re-execute user prompts.
 *
 * @module services/ChatPersistenceService
 */

import type { Message } from "@ai-sdk/react";
import { agentStore } from "../store/agentStore";
import type { ConversationScope } from "../hooks/conversationScope";

export class ChatPersistenceService {
  /**
   * Sync messages to global store
   * Enables cross-tab message access
   * The cache key includes the complete conversation scope. It is never a
   * hydration authority; replay owns canonical transcript state.
   */
  syncToStore(scope: ConversationScope, messages: Message[]): void {
    agentStore.setMessages(scope, messages);
  }
}
