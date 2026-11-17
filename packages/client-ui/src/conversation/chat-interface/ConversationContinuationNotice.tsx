export interface ConversationContinuationNoticeProps {
  readonly status: "reconnecting" | "stopped";
  readonly error: string | null;
  readonly onRetry: () => void;
}

/** Existing conversation recovery presentation, shared by Web and Desktop. */
export function ConversationContinuationNotice(props: ConversationContinuationNoticeProps) {
  return (
    <div
      className="mb-4 flex max-h-24 items-center justify-between gap-3 overflow-y-auto rounded border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
      role="status"
    >
      <span>
        {props.status === "reconnecting"
          ? "Reconnecting to live updates…"
          : `Live updates stopped${props.error ? `: ${props.error}` : "."}`}
      </span>
      {props.status === "stopped" ? (
        <button
          type="button"
          className="rounded border border-amber-200/40 px-2 py-1 text-xs hover:bg-amber-900/40"
          onClick={props.onRetry}
        >
          Retry updates
        </button>
      ) : null}
    </div>
  );
}
