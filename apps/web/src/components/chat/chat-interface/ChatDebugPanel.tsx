import type { ChatDebugEvent } from "../../../types/chat-debug.js";
import { formatDebugPayload } from "./debugPayload.js";

export function ChatDebugPanel({ events }: { events: ChatDebugEvent[] }) {
  return (
    <div className="rounded border border-cyan-800/60 bg-cyan-950/20">
      <div className="border-b border-cyan-800/40 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-cyan-200">
        Debug Trace (Client)
      </div>
      <div className="max-h-56 space-y-3 overflow-y-auto p-3">
        {events.length === 0 ? (
          <div className="text-xs text-cyan-300/70">
            Waiting for first request...
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="rounded border border-cyan-900/60 bg-black/50 p-2"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                  {event.phase}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="mb-2 text-xs text-cyan-100">{event.summary}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-zinc-200">
                {formatDebugPayload(event.payload)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
