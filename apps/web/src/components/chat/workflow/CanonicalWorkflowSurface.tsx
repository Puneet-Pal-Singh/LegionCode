import { useEffect, useMemo, useState } from "react";
import {
  groupToolActivity,
  type TurnWorkflowProjection,
} from "@repo/platform-client-sdk";
import { WorkflowDisclosure } from "./WorkflowDisclosure.js";
import { WorkflowSummaryButton } from "./WorkflowSummaryButton.js";
import {
  formatTurnDuration,
  resolveWorkflowTitle,
  useWorkflowClock,
} from "./workflowPresentation.js";

interface CanonicalWorkflowSurfaceProps {
  projection: TurnWorkflowProjection;
}

export function CanonicalWorkflowSurface({
  projection,
}: CanonicalWorkflowSurfaceProps) {
  const terminal = projection.terminal;
  const [expanded, setExpanded] = useState(!terminal);
  const now = useWorkflowClock(Boolean(terminal));
  const segments = useMemo(
    () => groupToolActivity(projection.items),
    [projection.items],
  );
  const duration = formatTurnDuration(
    projection.startedAt,
    projection.settledAt,
    now,
  );
  const title = resolveWorkflowTitle(projection, segments, duration);

  useEffect(() => {
    if (terminal) {
      setExpanded(false);
    }
  }, [terminal]);

  return (
    <section
      aria-label="Canonical workflow"
      data-testid="canonical-workflow"
      data-phase={projection.phase}
      data-terminal-state={terminal?.state ?? undefined}
      className="max-w-full"
    >
      <WorkflowSummaryButton
        expanded={expanded}
        phase={projection.phase}
        title={title}
        onToggle={() => setExpanded((current) => !current)}
      />
      {expanded ? (
        <WorkflowDisclosure
          projection={projection}
          segments={segments}
        />
      ) : null}
    </section>
  );
}
