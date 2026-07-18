import type { HookInvocationAuditEvent } from "@repo/platform-client-sdk";
import { ChevronDown, Puzzle } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import {
  buildHookAuditDisclosureViewModel,
  type HookAuditTone,
} from "../../../services/activity/HookAuditViewModel.js";

interface HookAuditDisclosureProps {
  event: HookInvocationAuditEvent;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

/**
 * Read-only chat disclosure for a canonical HookInvocationAuditEvent.
 *
 * Callers must supply events from replay/live runtime continuation. This
 * component deliberately owns no hook execution, persistence, or browser
 * cache state.
 */
export function HookAuditDisclosure({
  event,
  expanded,
  onToggle,
}: HookAuditDisclosureProps) {
  const model = buildHookAuditDisclosureViewModel(event);

  return (
    <section className="rounded-lg border border-zinc-800/80 bg-zinc-950/30">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900/60"
        onClick={() => onToggle(!expanded)}
      >
        <Puzzle className={cn("h-4 w-4 shrink-0", toneClass(model.tone))} />
        <span className="min-w-0 flex-1 truncate">{model.label}</span>
        <span className={cn("shrink-0 text-xs", toneClass(model.tone))}>
          {model.statusLabel}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-zinc-500 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-zinc-800/80 px-3 py-3 text-xs text-zinc-400">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-zinc-500">Event</dt>
            <dd>{model.eventLabel}</dd>
            <dt className="text-zinc-500">Source</dt>
            <dd>{model.sourceLabel}</dd>
            <dt className="text-zinc-500">Handler</dt>
            <dd className="truncate font-mono text-zinc-300">{model.handlerLabel}</dd>
            {model.durationLabel ? (
              <>
                <dt className="text-zinc-500">Duration</dt>
                <dd>{model.durationLabel}</dd>
              </>
            ) : null}
            {model.outcomeLabel ? (
              <>
                <dt className="text-zinc-500">Result</dt>
                <dd>{model.outcomeLabel}</dd>
              </>
            ) : null}
          </dl>

          {model.failure ? (
            <div className="rounded-md border border-red-950/80 bg-red-950/20 px-2.5 py-2 text-red-200">
              <p className="font-medium">Hook failed</p>
              <p className="mt-1 text-red-200/80">{model.failure.message}</p>
              <p className="mt-1 font-mono text-[11px] text-red-300/70">
                {model.failure.code}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function toneClass(tone: HookAuditTone): string {
  switch (tone) {
    case "running":
      return "text-sky-300";
    case "completed":
      return "text-zinc-400";
    case "failed":
      return "text-red-300";
    case "muted":
      return "text-zinc-500";
  }
}
