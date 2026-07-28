import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import {
  buildLifecycleTerminalViewModel,
} from "../../../services/lifecycle/LifecycleTerminalViewModel";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { buildConversationTurns } from "../messageMetadata";
import { buildChatEntries } from "./chatEntries";

interface ChatPresentationInput {
  messages: Message[];
  conversationTurns: ReturnType<typeof buildConversationTurns>;
  hasHydrated: boolean;
  isLoading: boolean;
  hasPendingApproval: boolean;
  hasStartedSession: boolean;
  lifecycleProjection?: LifecycleProjection | null;
  lifecycleProjectionsByTurnId?: Readonly<Record<string, LifecycleProjection>>;
}

export function useChatPresentation(input: ChatPresentationInput) {
  const chatEntries = useMemo(
    () =>
      buildChatEntries(
        input.conversationTurns,
        input.lifecycleProjectionsByTurnId,
      ),
    [input.conversationTurns, input.lifecycleProjectionsByTurnId],
  );
  const terminalViewModel = useMemo(
    () => buildLifecycleTerminalViewModel(input.lifecycleProjection ?? null),
    [input.lifecycleProjection],
  );
  const hasUserMessage = input.messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  );
  const hasConversation = hasUserMessage || chatEntries.length > 0;
  const showHeroComposer =
    input.hasHydrated &&
    !hasConversation &&
    !input.isLoading &&
    !input.hasPendingApproval &&
    !input.hasStartedSession;
  const isTranscriptHydrating =
    !input.hasHydrated && !hasConversation && !input.hasPendingApproval;
  const showSessionPlaceholder =
    isTranscriptHydrating ||
    (input.hasStartedSession &&
      input.hasHydrated &&
      !hasConversation &&
      !input.hasPendingApproval &&
      !showHeroComposer);

  return {
    chatEntries,
    terminalViewModel,
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder,
  };
}
