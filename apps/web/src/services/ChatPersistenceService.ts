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

export class ChatPersistenceService {
  /**
   * Sync messages to global store
   * Enables cross-tab message access
   * Key: shadowbox:run:{runId}:messages
   */
  syncToStore(runId: string, messages: Message[]): void {
    agentStore.setMessages(runId, messages);
  }
}
