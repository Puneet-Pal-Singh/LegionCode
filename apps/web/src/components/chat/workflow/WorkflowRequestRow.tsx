import { useState } from "react";
import { ChevronRight, Hand, ListChecks } from "lucide-react";
import type { WorkflowItem } from "@repo/platform-client-sdk";
import { cn } from "../../../lib/utils.js";

const REQUEST_STATE_LABELS = {
  approved: "Accepted",
  denied: "Denied",
  cancelled: "Cancelled",
  timed_out: "Expired",
  answered: "Answered",
  resolved: "Resolved",
} as const;

/** Permission and question history is rendered from SDK replay, including its answer. */
export function WorkflowRequestRow({
  item,
  className,
}: {
  item: WorkflowItem;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const approval = item.kind === "approval_request";
  const Icon = approval ? Hand : ListChecks;
  const label = approval ? "Requested permission" : "Asked questions";
  const request = item.request;

  return (
    <div data-item-id={item.itemId} data-item-status={item.status}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`View details for ${label}`}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex max-w-full items-center gap-2 text-left text-zinc-500 hover:text-zinc-100",
          className,
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="ml-6 space-y-2 py-1 text-sm leading-5 text-zinc-400">
          {request?.questions.map((question) => (
            <div key={question.id}>
              <p className="whitespace-pre-wrap break-words">
                {question.question}
              </p>
              {request.answers
                .filter((answer) => answer.questionId === question.id)
                .map((answer, index) => (
                  <p
                    key={index}
                    className="mt-1 whitespace-pre-wrap break-words text-zinc-500"
                  >
                    {answer.value}
                  </p>
                ))}
            </div>
          ))}
          {!request ? <p>{item.text || item.detail}</p> : null}
          {request && request.answers.length === 0 ? (
            <p className="text-zinc-500">
              {request.state === "pending"
                ? approval
                  ? "Awaiting approval"
                  : "Waiting for your answer"
                : REQUEST_STATE_LABELS[request.state]}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
