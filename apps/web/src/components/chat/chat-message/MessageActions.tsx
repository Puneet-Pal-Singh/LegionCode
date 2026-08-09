import { Anchor } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "../../../lib/utils";
import type { HookInvocationAuditEvent } from "../../../services/api/lifecycleClient";
import type { ChatMessageMetadata } from "../messageMetadata";

export function MessageActions({
  content,
  metadata,
  isUser,
  hookAudits = [],
}: {
  content: string;
  metadata?: ChatMessageMetadata;
  isUser: boolean;
  hookAudits?: readonly HookInvocationAuditEvent[];
}) {
  if (!metadata && hookAudits.length === 0) return null;
  const metadataText = metadata
    ? isUser
      ? (metadata.timeLabel ?? "")
      : [metadata.modeLabel, metadata.modelLabel, metadata.timeLabel]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(" · ")
    : "";
  if (!metadataText && hookAudits.length === 0) return null;
  return (
    <MessageActionRow
      content={content}
      metadataText={metadataText}
      isUser={isUser}
      hookAudits={hookAudits}
    />
  );
}

function MessageActionRow({
  content,
  metadataText,
  isUser,
  hookAudits,
}: {
  content: string;
  metadataText: string;
  isUser: boolean;
  hookAudits: readonly HookInvocationAuditEvent[];
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
      {!isUser && hookAudits.length > 0 ? (
        <HookAuditAction audits={hookAudits} />
      ) : null}
      {metadataText ? <span>{metadataText}</span> : null}
      {isUser && canCopy && <CopyButton onCopy={handleCopy} />}
    </div>
  );
}

function HookAuditAction({
  audits,
}: {
  audits: readonly HookInvocationAuditEvent[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className={cn(
          "rounded p-1 transition hover:bg-zinc-800 hover:text-zinc-200",
          isOpen ? "bg-zinc-800 text-zinc-200" : "text-zinc-500",
        )}
        aria-label="View hook activity"
        aria-expanded={isOpen}
      >
        <Anchor size={14} aria-hidden="true" />
      </button>
      {isOpen ? (
        <span className="ui-surface-popover absolute bottom-8 left-0 z-40 block min-w-64 p-3 text-left text-sm text-zinc-200">
          <span className="mb-2 block font-medium">Hooks</span>
          <span className="space-y-1.5">
            {audits.map((audit) => (
              <span
                key={audit.invocation.invocationId}
                className="flex items-center justify-between gap-5"
              >
                <span className="text-zinc-200">
                  {formatHookEventName(audit.invocation.eventName)}
                </span>
                <span className="capitalize text-zinc-500">
                  {audit.invocation.source} ·{" "}
                  {formatHookStatus(audit.invocation.status)}
                </span>
              </span>
            ))}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function formatHookEventName(eventName: string): string {
  return eventName.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatHookStatus(status: string): string {
  return status.replaceAll("_", " ");
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
