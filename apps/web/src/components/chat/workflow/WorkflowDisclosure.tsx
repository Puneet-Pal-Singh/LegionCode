import type {
  ToolActivitySegment,
  TurnWorkflowProjection,
} from "@repo/platform-client-sdk";
import { WorkflowPlanDiff } from "./WorkflowPlanDiff.js";
import { WorkflowTimeline } from "./WorkflowTimeline.js";

interface WorkflowDisclosureProps {
  projection: TurnWorkflowProjection;
  segments: readonly ToolActivitySegment[];
}

export function WorkflowDisclosure({
  projection,
  segments,
}: WorkflowDisclosureProps) {
  return (
    <div className="ml-1 mt-1 max-w-3xl border-l border-zinc-800/90 pl-4">
      <WorkflowPlanDiff projection={projection} />
      {projection.pendingApproval ? (
        <div className="mb-3 border-l-2 border-amber-500/70 pl-3 text-sm">
          <div className="font-medium text-amber-200">Approval needed</div>
          <div className="mt-0.5 text-xs text-amber-100/65">
            {projection.pendingApproval.question}
          </div>
        </div>
      ) : null}
      <WorkflowTimeline
        segments={segments}
        showStartingState={
          segments.length === 0 && !projection.pendingApproval && !projection.terminal
        }
      />
    </div>
  );
}
