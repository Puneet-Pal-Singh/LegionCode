import type { Message } from "@ai-sdk/react";
import type { ArtifactOpenHandler } from "./artifactOpen";
import { cn } from "../../lib/utils";
import type { ChatMessageMetadata } from "./messageMetadata";
import { ChangedFilesCard } from "./chat-message/ChangedFilesCard";
import { MessageActions } from "./chat-message/MessageActions";
import { MessageArtifacts } from "./chat-message/MessageArtifacts";
import { MessageContent } from "./chat-message/MessageContent";
import type { ChangedFilesSummary } from "./chat-message/types";
import { useMessageDisplayContent } from "./chat-message/useMessageDisplayContent";
import type { HookInvocationAuditEvent } from "../../services/api/lifecycleClient";

interface ChatMessageProps {
  message: Message;
  metadata?: ChatMessageMetadata;
  onArtifactOpen?: ArtifactOpenHandler;
  onReviewOpen?: () => void;
  changedFilesSummary?: ChangedFilesSummary;
  hookAudits?: readonly HookInvocationAuditEvent[];
}

export function ChatMessage({
  message,
  metadata,
  onArtifactOpen,
  onReviewOpen,
  changedFilesSummary,
  hookAudits = [],
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const displayContent = useMessageDisplayContent(
    message,
    isUser,
    changedFilesSummary,
  );

  return (
    <div
      className={cn(
        "group flex gap-4 w-full",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "max-w-4xl",
          isUser ? "flex flex-col items-end" : "flex-1",
        )}
      >
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
          hookAudits={hookAudits}
        />
      </div>
    </div>
  );
}
