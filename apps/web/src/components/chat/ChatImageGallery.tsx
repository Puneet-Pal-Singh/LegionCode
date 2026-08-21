import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { formatAttachmentSize, isChatImageMimeType } from "./chatImageAttachments";

export interface ChatImagePreview {
  id: string;
  name: string;
  mediaType: string;
  byteSize?: number;
  /** A URL owned by the current client session. Durable messages may omit it. */
  src?: string;
}

interface ChatImageGalleryProps {
  images: readonly ChatImagePreview[];
  onRemove?: (imageId: string) => void;
  emptyPreviewLabel?: string;
  className?: string;
}

/**
 * Shared image presentation for the composer and transcript.
 * It only renders typed image parts or server-provided attachment metadata;
 * it never attempts to turn arbitrary text into an image URL.
 */
export function ChatImageGallery({
  images,
  onRemove,
  emptyPreviewLabel = "Preview unavailable after reload",
  className,
}: ChatImageGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const activeImage =
    openIndex !== null && openIndex < images.length
      ? images[openIndex]
      : undefined;

  useEffect(() => {
    if (openIndex === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenIndex(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openIndex]);

  if (images.length === 0) return null;

  return (
    <>
      <div
        className={cn("flex flex-wrap gap-2", className)}
        aria-label="Attached images"
      >
        {images.map((image, index) => {
          const hasPreview = Boolean(image.src) && isChatImageMimeType(image.mediaType);
          const imageLabel = `${image.name}, ${image.mediaType}${image.byteSize ? `, ${formatAttachmentSize(image.byteSize)}` : ""}`;
          return (
            <figure
              key={image.id}
              className="group relative h-20 w-20 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 shadow-sm"
            >
              {hasPreview ? (
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  onClick={() => setOpenIndex(index)}
                  aria-label={`Open image ${index + 1}: ${imageLabel}`}
                >
                  <img
                    src={image.src}
                    alt={`Attached image ${index + 1}: ${imageLabel}`}
                    className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                  />
                </button>
              ) : (
                <div
                  className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-zinc-500"
                  title={emptyPreviewLabel}
                  aria-label={`${imageLabel}. ${emptyPreviewLabel}`}
                >
                  <ImageIcon size={18} aria-hidden="true" />
                  <span className="max-w-full truncate text-[10px]">{image.name}</span>
                </div>
              )}
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(image.id)}
                  className="absolute right-1 top-1 rounded-full bg-white p-1 text-black opacity-0 shadow transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  aria-label={`Remove attached image ${index + 1}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </figure>
          );
        })}
      </div>

      {activeImage?.src ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview: ${activeImage.name}`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpenIndex(null);
          }}
        >
          <button
            type="button"
            onClick={() => setOpenIndex(null)}
            className="absolute right-5 top-5 rounded-full bg-zinc-800/90 p-3 text-zinc-100 shadow-lg transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            aria-label="Close image preview"
          >
            <X size={20} aria-hidden="true" />
          </button>
          {images.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => setOpenIndex((openIndex! - 1 + images.length) % images.length)}
                className="absolute left-5 rounded-full bg-zinc-800/90 p-3 text-zinc-100 shadow-lg transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                aria-label="Previous image"
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setOpenIndex((openIndex! + 1) % images.length)}
                className="absolute right-5 rounded-full bg-zinc-800/90 p-3 text-zinc-100 shadow-lg transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                aria-label="Next image"
              >
                <ChevronRight size={22} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <img
            src={activeImage.src}
            alt={activeImage.name}
            className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
          />
        </div>
      ) : null}
    </>
  );
}
