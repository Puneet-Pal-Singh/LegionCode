export interface ChatErrorNoticeProps {
  message: string;
  remediation: string;
  actionLabel: string;
  technicalDetails?: string;
  onOpen?: () => void;
}


export function ChatErrorNotice({
  message,
  remediation,
  actionLabel,
  technicalDetails,
  onOpen,
}: ChatErrorNoticeProps) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm text-zinc-300"
    >
      <p className="min-w-0 flex-1">{message}</p>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="rounded px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
        >
          {actionLabel}
        </button>
      ) : null}
      <details className="basis-full text-xs text-zinc-500">
        <summary className="w-fit cursor-pointer select-none hover:text-zinc-300">
          Details
        </summary>
        <p className="mt-1 text-zinc-400">{remediation}</p>
        {technicalDetails ? (
          <p className="mt-1 font-mono text-zinc-500">{technicalDetails}</p>
        ) : null}
      </details>
    </div>
  );
}
