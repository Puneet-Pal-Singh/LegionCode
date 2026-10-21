import { CircleAlert, Pause } from "lucide-react";
import type { ReactNode } from "react";
import { formatTimestamp } from "../messageMetadata";

function Marker({
  children,
  role,
  lines = true,
}: {
  children: ReactNode;
  role?: "status" | "alert";
  lines?: boolean;
}) {
  return (
    <div
      role={role}
      className="my-5 flex items-center justify-center gap-3 text-xs leading-5 text-zinc-500"
    >
      {lines ? (
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-zinc-800/70"
        />
      ) : null}
      <span className="flex min-w-0 items-center justify-center gap-2 text-center">
        {children}
      </span>
      {lines ? (
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-zinc-800/70"
        />
      ) : null}
    </div>
  );
}

export function ConversationTimeMarker({
  at,
  label,
}: {
  at: Date | string | undefined | null;
  label?: string;
}) {
  if (!at) return null;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const today = date.toDateString() === new Date().toDateString();
  const day = today
    ? "Today"
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = formatTimestamp(date.getTime());
  return (
    <Marker lines={false}>
      <time dateTime={date.toISOString()}>
        {label ? `${label} · ` : ""}
        {day} {time}
      </time>
    </Marker>
  );
}

export function ConversationTerminalMarker({
  interrupted,
  content,
}: {
  interrupted: boolean;
  content: string;
}) {
  return (
    <Marker role={interrupted ? "status" : "alert"}>
      {interrupted ? (
        <Pause size={13} className="shrink-0" />
      ) : (
        <CircleAlert size={13} className="shrink-0" />
      )}
      <span>
        {content && content !== "interrupted"
          ? content
          : interrupted
            ? "Turn interrupted"
            : "The run ended before it could return an answer. Retry the request."}
      </span>
    </Marker>
  );
}

export function ConversationNoticeMarker({ message }: { message: string }) {
  return (
    <Marker role="status">
      <CircleAlert size={13} className="shrink-0" />
      <span>{message}</span>
    </Marker>
  );
}
