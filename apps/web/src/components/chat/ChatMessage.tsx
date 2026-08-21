import type { Message } from "@ai-sdk/react";
import type { ArtifactOpenHandler } from "./artifactOpen";
import { useState } from "react";
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
  onEdit?: (content: string) => Promise<boolean>;
}

export function ChatMessage({
  message,
  metadata,
  onArtifactOpen,
  onReviewOpen,
  changedFilesSummary,
  hookAudits = [],
  onEdit,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
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
        {isEditing ? (
          <div className="w-full max-w-xl space-y-2">
            <textarea
              value={editedContent}
              onChange={(event) => setEditedContent(event.target.value)}
              className="min-h-24 w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none focus:border-zinc-400"
              aria-label="Edit prompt"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setEditedContent(message.content);
                  setIsEditing(false);
                }}
                className="rounded-md px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!editedContent.trim()}
                onClick={async () => {
                  if (!onEdit) return;
                  const accepted = await onEdit(editedContent);
                  if (accepted) setIsEditing(false);
                }}
                className="rounded-md bg-zinc-100 px-2.5 py-1.5 font-medium text-zinc-950 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <MessageContent content={displayContent} isUser={isUser} />
        )}
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
          onEdit={onEdit ? () => setIsEditing(true) : undefined}
        />
      </div>
    </div>
  );
}
