import { ChevronDown } from "lucide-react";
import {
  workflowPhaseLabel,
  type TurnWorkflowProjection,
} from "@repo/platform-client-sdk";
import { cn } from "../../../lib/utils.js";

interface WorkflowSummaryButtonProps {
  expanded: boolean;
  phase: TurnWorkflowProjection["phase"];
  title: string;
  onToggle: () => void;
}

export function WorkflowSummaryButton({
  expanded,
  phase,
  title,
  onToggle,
}: WorkflowSummaryButtonProps) {
  return (
    <button
      type="button"
      className="group flex w-full max-w-full items-center gap-2 border-b border-zinc-800/90 py-2 text-left text-sm text-zinc-400 transition-colors hover:text-zinc-200"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="truncate font-medium text-zinc-300">{title}</span>
      <span className="sr-only">{workflowPhaseLabel(phase)}</span>
      <ChevronDown
        aria-hidden="true"
        size={14}
        className={cn(
          "shrink-0 text-zinc-600 transition-transform group-hover:text-zinc-400",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}
