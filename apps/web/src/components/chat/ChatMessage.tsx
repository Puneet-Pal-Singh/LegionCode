import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { cn } from "../../lib/utils";
import type { ChatMessageMetadata } from "./messageMetadata";
import { ChangedFilesCard } from "./chat-message/ChangedFilesCard";
import { MessageActions } from "./chat-message/MessageActions";
import { MessageArtifacts } from "./chat-message/MessageArtifacts";
import { MessageContent } from "./chat-message/MessageContent";
import {
  extractMessageText,
  stripAssistantChangeCounts,
  visibleAssistantContent,
} from "./chat-message/markdownTransforms";
import type { ChangedFilesSummary } from "./chat-message/types";

interface ChatMessageProps {
  message: Message;
  metadata?: ChatMessageMetadata;
  onArtifactOpen?: (path: string, content: string) => void;
  onReviewOpen?: () => void;
  changedFilesSummary?: ChangedFilesSummary;
}

export function ChatMessage({
  message,
  metadata,
  onArtifactOpen,
  onReviewOpen,
  changedFilesSummary,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const content = useMemo(() => {
    const extractedText = extractMessageText(message.content);
    return message.role === "assistant"
      ? visibleAssistantContent(extractedText)
      : extractedText.trim();
  }, [message.content, message.role]);
  const displayContent = useMemo(
    () =>
      !isUser && changedFilesSummary && content
        ? stripAssistantChangeCounts(content)
        : content,
    [changedFilesSummary, content, isUser],
  );

  return (
    <div
      className={cn(
        "group flex gap-4 w-full",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div className={cn("max-w-4xl", isUser ? "text-right" : "flex-1")}>
        <MessageContent content={displayContent} isUser={isUser} />
        {!isUser && (
          <MessageArtifacts message={message} onArtifactOpen={onArtifactOpen} />
        )}
        {!isUser &&
          changedFilesSummary &&
          changedFilesSummary.files.length > 0 && (
            <ChangedFilesCard
              files={changedFilesSummary.files}
              loadFileDiff={changedFilesSummary.loadFileDiff}
              onReviewOpen={changedFilesSummary.onReviewOpen ?? onReviewOpen}
            />
          )}
        <MessageActions
          content={displayContent}
          metadata={metadata}
          isUser={isUser}
        />
      </div>
    </div>
  );
}
