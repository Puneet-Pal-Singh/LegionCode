import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { buildLifecycleTerminalViewModel } from "../../../services/lifecycle/LifecycleTerminalViewModel";
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
  initialPromptSubmission?: { id: string; prompt: string } | null;
}

function buildPresentedChatEntries(input: ChatPresentationInput) {
  const canonicalEntries = buildChatEntries(
    input.conversationTurns,
    input.lifecycleProjectionsByTurnId,
    input.lifecycleProjection?.turnId,
  );
  const initialPrompt = input.initialPromptSubmission?.prompt.trim();
  const alreadyProjected = input.messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim() === initialPrompt,
  );
  if (!initialPrompt || alreadyProjected) return canonicalEntries;
  return [
    {
      kind: "message" as const,
      message: {
        id: `initial-prompt:${input.initialPromptSubmission?.id}`,
        role: "user" as const,
        content: initialPrompt,
      },
    },
    ...canonicalEntries,
  ];
}

function derivePresentationVisibility(
  input: ChatPresentationInput,
  hasConversation: boolean,
) {
  const showHeroComposer =
    input.hasHydrated &&
    !hasConversation &&
    !input.isLoading &&
    !input.hasPendingApproval &&
    !input.hasStartedSession;
  const isTranscriptHydrating =
    !input.hasHydrated && !hasConversation && !input.hasPendingApproval;
  return {
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder: isTranscriptHydrating,
  };
}

export function useChatPresentation(input: ChatPresentationInput) {
  const chatEntries = useMemo(() => buildPresentedChatEntries(input), [
    input.conversationTurns,
    input.initialPromptSubmission,
    input.lifecycleProjection?.turnId,
    input.lifecycleProjectionsByTurnId,
    input.messages,
  ]);
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
  const visibility = derivePresentationVisibility(input, hasConversation);

  return {
    chatEntries,
    terminalViewModel,
    ...visibility,
  };
}
