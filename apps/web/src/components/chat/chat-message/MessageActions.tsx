import { useCallback } from "react";
import { cn } from "../../../lib/utils";
import type { ChatMessageMetadata } from "../messageMetadata";

export function MessageActions({
  content,
  metadata,
  isUser,
}: {
  content: string;
  metadata?: ChatMessageMetadata;
  isUser: boolean;
}) {
  if (!metadata) return null;
  const metadataText = isUser
    ? (metadata.timeLabel ?? "")
    : [metadata.modeLabel, metadata.modelLabel, metadata.timeLabel]
        .filter((value): value is string => Boolean(value?.trim()))
        .join(" · ");
  if (!metadataText) return null;
  return (
    <MessageActionRow
      content={content}
      metadataText={metadataText}
      isUser={isUser}
    />
  );
}

function MessageActionRow({
  content,
  metadataText,
  isUser,
}: {
  content: string;
  metadataText: string;
  isUser: boolean;
}) {
  const canCopy = content.length > 0;
  const handleCopy = useCallback(async () => {
    if (!canCopy || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.warn("[chat/message] Failed to copy message", error);
    }
  }, [canCopy, content]);
  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 text-xs text-zinc-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && canCopy && <CopyButton onCopy={handleCopy} />}
      <span>{metadataText}</span>
      {isUser && canCopy && <CopyButton onCopy={handleCopy} />}
    </div>
  );
}

function CopyButton({ onCopy }: { onCopy: () => Promise<void> }) {
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="rounded p-1 text-zinc-500 hover:text-zinc-300"
      aria-label="Copy message"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}
