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
import { ChatImageGallery, type ChatImagePreview } from "./ChatImageGallery";
import { isChatImageMimeType } from "./chatImageAttachments";
import {
  resolveHydratedChatImageSource,
  stripRedactedImageMarkers,
} from "./chatMessageImagePresentation";

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
  const imagePreviews = isUser ? readMessageImagePreviews(message) : [];
  const visibleContent =
    isUser && imagePreviews.length > 0
      ? stripRedactedImageMarkers(displayContent)
      : displayContent;

  return (
    <div
      className={cn(
        "group flex gap-4 w-full",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          isUser
            ? "flex w-fit max-w-[92%] flex-col items-end sm:max-w-[68%]"
            : "max-w-4xl flex-1",
        )}
      >
        {isEditing ? (
          <div className="w-full max-w-xl space-y-2">
            {imagePreviews.length > 0 ? (
              <ChatImageGallery images={imagePreviews} />
            ) : null}
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
          <>
            {imagePreviews.length > 0 ? (
              <ChatImageGallery
                images={imagePreviews}
                className={visibleContent ? "mb-2 justify-end" : "justify-end"}
              />
            ) : null}
            <MessageContent content={visibleContent} isUser={isUser} />
          </>
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
          content={visibleContent}
          metadata={metadata}
          isUser={isUser}
          hookAudits={hookAudits}
          onEdit={onEdit ? () => setIsEditing(true) : undefined}
        />
      </div>
    </div>
  );
}

function readMessageImagePreviews(message: Message): ChatImagePreview[] {
  const metadata = readMessageMetadata(message);
  const metadataImages = Array.isArray(metadata?.imageAttachments)
    ? metadata.imageAttachments.flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const record = value as Record<string, unknown>;
        const name =
          typeof record.name === "string" ? record.name : `image-${index + 1}`;
        const mediaType =
          typeof record.mediaType === "string" ? record.mediaType : "";
        const id =
          typeof record.attachmentId === "string"
            ? record.attachmentId
            : typeof record.id === "string"
              ? record.id
              : `image-${index + 1}`;
        const src =
          typeof record.src === "string"
            ? resolveHydratedChatImageSource(record.src)
            : undefined;
        return [
          {
            id,
            name,
            mediaType,
            byteSize:
              typeof record.byteSize === "number" ? record.byteSize : undefined,
            src,
          },
        ];
      })
    : [];
  const parts = Array.isArray(message.content) ? message.content : [];
  const typedImageParts = parts.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (record.type !== "image" || typeof record.image !== "string") return [];
    const mediaType =
      typeof record.mimeType === "string"
        ? record.mimeType
        : typeof record.mediaType === "string"
          ? record.mediaType
          : "";
    if (
      !isChatImageMimeType(mediaType) ||
      !isSafeImagePartSource(record.image, mediaType)
    ) {
      return [];
    }
    return [
      {
        id:
          typeof record.id === "string"
            ? record.id
            : (metadataImages[index]?.id ?? `image-${index + 1}`),
        name:
          typeof record.name === "string"
            ? record.name
            : (metadataImages[index]?.name ?? `image-${index + 1}`),
        mediaType,
        byteSize: metadataImages[index]?.byteSize,
        src: record.image,
      },
    ];
  });
  return typedImageParts.length > 0 ? typedImageParts : metadataImages;
}

function readMessageMetadata(message: Message): Record<string, unknown> | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const metadata = (data as Record<string, unknown>).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function isSafeImagePartSource(source: string, mediaType: string): boolean {
  return source.startsWith(`data:${mediaType};base64,`);
}
