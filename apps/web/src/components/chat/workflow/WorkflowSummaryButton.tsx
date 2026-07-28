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
  const terminal = phase === "completed" || phase === "failed" || phase === "interrupted";
  return (
    <button
      type="button"
      className="group flex max-w-full items-center gap-2 py-1.5 text-left text-sm text-zinc-400 transition-colors hover:text-zinc-200"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-2 w-2 shrink-0 rounded-full border",
          phase === "failed" && "border-red-400 bg-red-400/60",
          phase === "interrupted" && "border-zinc-500 bg-zinc-600",
          phase === "completed" && "border-zinc-500 bg-zinc-500",
          !terminal &&
            "border-sky-400 bg-sky-400/70 motion-safe:animate-pulse motion-reduce:animate-none",
        )}
      />
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
