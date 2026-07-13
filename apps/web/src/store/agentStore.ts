import type { Message } from "@ai-sdk/react";
import {
  conversationScopeKey,
  type ConversationScope,
} from "../hooks/conversationScope";

class AgentStore {
  private messagesMap: Map<string, Message[]> = new Map();

  getMessages(scope: ConversationScope): Message[] {
    return this.messagesMap.get(conversationScopeKey(scope)) ?? [];
  }

  setMessages(scope: ConversationScope, messages: Message[]): void {
    this.messagesMap.set(conversationScopeKey(scope), messages);
  }

  clearMessages(scope: ConversationScope): void {
    this.messagesMap.delete(conversationScopeKey(scope));
  }

  /** Session cleanup cannot reconstruct a complete cache scope; remove all
   * cached entries for the run without exposing run-only transcript reads. */
  clearMessagesForRun(runId: string): void {
    for (const key of this.messagesMap.keys()) {
      if (key.endsWith(`/${encodeURIComponent(runId)}`)) {
        this.messagesMap.delete(key);
      }
    }
  }

  clearAllMessages() {
    this.messagesMap.clear();
  }
}

export const agentStore = new AgentStore();
