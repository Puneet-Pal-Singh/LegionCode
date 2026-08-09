import { ChevronDown, ChevronRight } from "lucide-react";
import {
  workflowPhaseLabel,
  type TurnWorkflowProjection,
} from "@repo/platform-client-sdk";

interface WorkflowSummaryButtonProps {
  expanded: boolean;
  phase: TurnWorkflowProjection["phase"];
  title: string;
  collapsible: boolean;
  onToggle: () => void;
}

export function WorkflowSummaryButton({
  expanded,
  phase,
  title,
  collapsible,
  onToggle,
}: WorkflowSummaryButtonProps) {
  const content = (
    <>
      <span className="truncate font-medium text-zinc-300">{title}</span>
      <span className="sr-only">{workflowPhaseLabel(phase)}</span>
    </>
  );

  if (!collapsible) {
    return (
      <div
        role="status"
        className="flex w-full max-w-full items-center border-b border-zinc-800/90 py-2 text-left text-sm text-zinc-400"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group flex w-full max-w-full items-center gap-2 border-b border-zinc-800/90 py-2 text-left text-sm text-zinc-400 transition-colors hover:text-zinc-200"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {content}
      {expanded ? (
        <ChevronDown
          aria-hidden="true"
          data-testid="workflow-summary-chevron-down"
          size={15}
          className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
        />
      ) : (
        <ChevronRight
          aria-hidden="true"
          data-testid="workflow-summary-chevron-right"
          size={15}
          className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
        />
      )}
    </button>
  );
}
