import type {
  ToolActivitySegment,
  TurnWorkflowProjection,
} from "@repo/platform-client-sdk";
import { WorkflowTimeline } from "./WorkflowTimeline.js";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";
import type { ArtifactOpenHandler } from "../artifactOpen.js";

interface WorkflowDisclosureProps {
  projection: TurnWorkflowProjection;
  segments: readonly ToolActivitySegment[];
  turnDiff: TurnDiffPayload | null;
  onArtifactOpen?: ArtifactOpenHandler;
}

export function WorkflowDisclosure({
  projection,
  segments,
  turnDiff,
  onArtifactOpen,
}: WorkflowDisclosureProps) {
  return (
    <div className="mt-1 min-w-0 w-full py-2">
      <WorkflowTimeline
        segments={segments}
        turnDiff={turnDiff}
        onArtifactOpen={onArtifactOpen}
        showThinkingState={
          !projection.pendingApproval &&
          !projection.terminal &&
          (segments.length === 0 ||
            !segments.some((segment) => segment.isActive))
        }
      />
    </div>
  );
}
