import { ThinkingIndicator } from "./ThinkingIndicator.js";

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
  void startedAt;

  return (
    <section
      aria-label="Pending workflow admission"
      data-testid="pending-workflow"
      className="max-w-full"
    >
      <ThinkingIndicator />
    </section>
  );
}
