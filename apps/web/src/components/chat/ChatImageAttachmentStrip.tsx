import type { ChatImageAttachment } from "./chatImageAttachments";
import { ChatImageGallery } from "./ChatImageGallery";

interface ChatImageAttachmentStripProps {
  attachments: ChatImageAttachment[];
  onRemove: (attachmentId: string) => void;
}

export function ChatImageAttachmentStrip({
  attachments,
  onRemove,
}: ChatImageAttachmentStripProps) {
  if (attachments.length === 0) return null;

  return (
    <ChatImageGallery
      images={attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteSize: attachment.byteSize,
        src: attachment.previewUrl,
      }))}
      onRemove={onRemove}
      className="mb-3"
    />
  );
}
