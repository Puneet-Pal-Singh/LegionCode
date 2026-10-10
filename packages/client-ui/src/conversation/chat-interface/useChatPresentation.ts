import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { buildLifecycleTerminalViewModel } from "./LifecycleTerminalViewModel.js";
import type { LifecycleProjection } from "@legioncode/sdk";
import type { ConversationTurn } from "@legioncode/sdk";
import { buildChatEntries } from "./chatEntries.js";

interface ChatPresentationInput {
  messages: Message[];
  conversationTurns: ConversationTurn<Message>[];
  hasHydrated: boolean;
  isLoading: boolean;
  hasPendingApproval: boolean;
  hasStartedSession: boolean;
  lifecycleProjection?: LifecycleProjection | null;
  lifecycleProjectionsByTurnId?: Readonly<Record<string, LifecycleProjection>>;
  initialPromptSubmission?: {
    id: string;
    prompt: string;
    status: "queued" | "submitting" | "failed";
  } | null;
  hasImmediateUserSubmission?: boolean;
}

function buildPresentedChatEntries(input: ChatPresentationInput) {
  const canonicalEntries = buildChatEntries(
    input.conversationTurns,
    input.lifecycleProjectionsByTurnId,
    input.lifecycleProjection?.turnId,
  );
  const submissionId = input.initialPromptSubmission?.id;
  const initialPrompt = input.initialPromptSubmission?.prompt.trim();
  if (
    input.initialPromptSubmission?.status === "submitting" &&
    input.hasImmediateUserSubmission
  ) {
    return canonicalEntries;
  }
  const alreadyProjected = input.messages.some(
    (message) =>
      message.role === "user" && message.id === `client_msg_${submissionId}`,
  );
  if (!initialPrompt || alreadyProjected) return canonicalEntries;
  return [
    {
      kind: "message" as const,
      message: {
        id: `client_msg_${submissionId}`,
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
  const isTranscriptHydrating = !input.hasHydrated;
  const hasImmediatePrompt =
    input.hasImmediateUserSubmission ||
    Boolean(input.initialPromptSubmission?.prompt.trim());
  return {
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder: isTranscriptHydrating && !hasImmediatePrompt,
  };
}

export function useChatPresentation(input: ChatPresentationInput) {
  const chatEntries = buildPresentedChatEntries(input);
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
