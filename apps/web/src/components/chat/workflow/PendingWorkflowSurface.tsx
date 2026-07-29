import { LoaderCircle } from "lucide-react";
import { useWorkflowClock, formatTurnDuration } from "./workflowPresentation.js";

interface PendingWorkflowSurfaceProps {
  startedAt: number;
}

/**
 * Presentation-only acknowledgement shown while the canonical turn scope and
 * replay are being admitted. It never invents tool, approval, or terminal
 * state and is replaced as soon as canonical lifecycle replay is available.
 */
export function PendingWorkflowSurface({
  startedAt,
}: PendingWorkflowSurfaceProps) {
  const now = useWorkflowClock(false);
  const duration = formatTurnDuration(
    new Date(startedAt).toISOString(),
    null,
    now,
  );

  return (
    <section
      aria-label="Pending workflow admission"
      data-testid="pending-workflow"
      className="max-w-full"
    >
      <div className="flex w-full items-center gap-2 border-b border-zinc-800/90 py-2 text-left text-sm text-zinc-400">
        <LoaderCircle
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin text-zinc-500"
        />
        <span className="font-medium text-zinc-300">
          Working for {duration}
        </span>
      </div>
      <p className="py-3 text-sm text-zinc-500" role="status">
        Thinking
      </p>
    </section>
  );
}
