import { useMemo, useState } from "react";
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
import type { ArtifactOpenHandler } from "../artifactOpen.js";

interface CanonicalWorkflowSurfaceProps {
  projection: TurnWorkflowProjection;
  onArtifactOpen?: ArtifactOpenHandler;
}

export function CanonicalWorkflowSurface({
  projection,
  onArtifactOpen,
}: CanonicalWorkflowSurfaceProps) {
  const terminal = projection.terminal;
  const [expanded, setExpanded] = useState(true);
  const now = useWorkflowClock(Boolean(terminal));
  const segments = useMemo(
    () => groupToolActivity(projection.items, projection.turnDiff),
    [projection.items, projection.turnDiff],
  );
  const duration = formatTurnDuration(
    projection.startedAt,
    projection.settledAt,
    now,
  );
  const title = resolveWorkflowTitle(projection, segments, duration);

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
          turnDiff={projection.turnDiff}
          onArtifactOpen={onArtifactOpen}
        />
      ) : null}
    </section>
  );
}
