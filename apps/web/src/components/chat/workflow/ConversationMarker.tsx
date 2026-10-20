import { CircleAlert, Pause } from "lucide-react";
import type { ReactNode } from "react";

function Marker({
  children,
  role,
}: {
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className="my-5 flex items-center gap-3 text-xs leading-5 text-zinc-500"
    >
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-zinc-800/70" />
      <span className="flex min-w-0 items-center justify-center gap-2 text-center">
        {children}
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-zinc-800/70" />
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
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <Marker>
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
