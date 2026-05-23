/**
 * ChatPersistenceService
 * Manages chat message persistence and retrieval
 *
 * Single Responsibility: Persist messages to store and session-scoped storage.
 * Uses SessionStateService for session-scoped key management.
 *
 * Storage Keys:
 * - shadowbox:run:{runId}:messages (in-memory via agentStore)
 * - shadowbox:pending-query:{sessionId} (per-session pending query)
 *
 * @module services/ChatPersistenceService
 */

import type { Message } from "@ai-sdk/react";
import { agentStore } from "../store/agentStore";
import { SessionStateService } from "./SessionStateService";

export class ChatPersistenceService {
  /**
   * Sync messages to global store
   * Enables cross-tab message access
   * Key: shadowbox:run:{runId}:messages
   */
  syncToStore(runId: string, messages: Message[]): void {
    agentStore.setMessages(runId, messages);
  }

  /**
   * Get pending query from session-scoped localStorage
   * Retrieves user input waiting to be executed for a specific session
   *
   * Key: shadowbox:pending-query:{sessionId}
   */
  getPendingQuery(sessionId: string): string | null {
    return SessionStateService.loadSessionPendingQuery(sessionId);
  }

  /**
   * Save pending query to session-scoped localStorage
   * Stores user input waiting to be executed
   *
   * Key: shadowbox:pending-query:{sessionId}
   */
  setPendingQuery(sessionId: string, query: string): void {
    SessionStateService.saveSessionPendingQuery(sessionId, query);
  }

  /**
   * Clear pending query from session-scoped localStorage
   * Removes user input after execution starts
   *
   * Key: shadowbox:pending-query:{sessionId}
   */
  clearPendingQuery(sessionId: string): void {
    SessionStateService.clearSessionPendingQuery(sessionId);
  }

  /**
   * Check if should restore pending query
   * Returns true if there are no messages and not currently loading
   */
  shouldRestorePendingQuery(
    messagesCount: number,
    isLoading: boolean,
  ): boolean {
    return messagesCount === 0 && !isLoading;
  }
}
