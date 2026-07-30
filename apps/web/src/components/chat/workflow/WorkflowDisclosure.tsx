import type {
  ToolActivitySegment,
  TurnWorkflowProjection,
} from "@repo/platform-client-sdk";
import { WorkflowTimeline } from "./WorkflowTimeline.js";

interface WorkflowDisclosureProps {
  projection: TurnWorkflowProjection;
  segments: readonly ToolActivitySegment[];
  onArtifactOpen?: (path: string, content: string) => void;
}

export function WorkflowDisclosure({
  projection,
  segments,
  onArtifactOpen,
}: WorkflowDisclosureProps) {
  return (
    <div className="mt-1 max-w-3xl py-2">
      {projection.pendingApproval ? (
        <div className="mb-3 border-l border-zinc-700 pl-3 text-sm">
          <div className="font-medium text-zinc-300">Approval needed</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {projection.pendingApproval.question}
          </div>
        </div>
      ) : null}
      <WorkflowTimeline
        segments={segments}
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
