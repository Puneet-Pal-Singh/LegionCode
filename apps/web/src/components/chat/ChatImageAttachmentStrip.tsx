import { X } from "lucide-react";
import {
  formatAttachmentSize,
  type ChatImageAttachment,
} from "./chatImageAttachments";

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
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Attached images">
      {attachments.map((attachment, index) => (
        <figure
          key={attachment.id}
          className="group relative h-20 w-20 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-sm"
        >
          <img
            src={attachment.previewUrl}
            alt={`Attached image ${index + 1}: ${attachment.name}, ${attachment.mediaType}, ${formatAttachmentSize(attachment.byteSize)}`}
            className="h-full w-full object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute right-1 top-1 rounded-full bg-white p-1 text-black shadow transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            aria-label={`Remove attached image ${index + 1}`}
          >
            <X size={12} />
          </button>
        </figure>
      ))}
    </div>
  );
}
