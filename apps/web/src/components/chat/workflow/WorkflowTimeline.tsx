import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  CircleAlert,
  FilePenLine,
  GitBranch,
  Globe,
  Search,
  Square,
  Terminal,
  Wrench,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import {
  buildSegmentTitle,
  type ToolActivitySegment,
  type WorkflowItem,
} from "@repo/platform-client-sdk";
import { MarkdownMessageContent } from "../chat-message/MessageContent.js";
import { cn } from "../../../lib/utils.js";
import { itemDisplayText } from "./workflowPresentation.js";

interface WorkflowTimelineProps {
  segments: readonly ToolActivitySegment[];
  showStartingState: boolean;
}

export function WorkflowTimeline({
  segments,
  showStartingState,
}: WorkflowTimelineProps) {
  if (showStartingState) {
    return (
      <p className="py-1 text-xs text-zinc-500" role="status">
        Starting the task…
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="workflow-tool-viewport">
      {segments.map((segment) => (
        <WorkflowSegment key={segment.key} segment={segment} />
      ))}
    </div>
  );
}

function WorkflowSegment({ segment }: { segment: ToolActivitySegment }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [segment.children.length]);

  const commentary =
    segment.children.length === 1 && segment.children[0]?.kind === "commentary"
      ? segment.children[0]
      : null;

  if (commentary) {
    return (
      <div className="py-1 text-[15px] leading-7 text-zinc-300">
        <MarkdownMessageContent content={itemDisplayText(commentary) ?? ""} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {segment.reasoning ? (
        <div className="text-[15px] leading-7 text-zinc-300">
          <MarkdownMessageContent
            content={itemDisplayText(segment.reasoning) ?? "Thinking"}
          />
        </div>
      ) : null}
      {segment.children.length > 0 ? (
        <ActivityDisclosure
          title={buildSegmentTitle(segment)}
          active={segment.isActive}
        >
          <div
            ref={viewportRef}
            onScroll={(event) => {
              const viewport = event.currentTarget;
              followRef.current =
                viewport.scrollHeight -
                  viewport.scrollTop -
                  viewport.clientHeight <
                24;
            }}
            className="max-h-60 space-y-1 overflow-y-auto pr-2"
          >
            {segment.children.map((item) => (
              <WorkflowItemRow key={item.itemId} item={item} />
            ))}
          </div>
        </ActivityDisclosure>
      ) : null}
    </div>
  );
}

function ActivityDisclosure({
  title,
  active,
  children,
}: {
  title: string;
  active: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="group flex items-center gap-2 py-1 text-sm text-zinc-500 transition hover:text-zinc-300"
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        <span className="first-letter:uppercase">{title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="ml-2 mt-1 border-l border-zinc-800 pl-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowItemRow({
  item,
  reasoning = false,
}: {
  item: WorkflowItem;
  reasoning?: boolean;
}) {
  const text = itemDisplayText(item);
  const isCommentary = item.kind === "commentary";
  const label = reasoning
    ? (item.safeSummary ?? "Thinking")
    : (item.safeSummary ?? item.toolFamily ?? humanizeKind(item.kind));
  const StatusIcon = resolveItemIcon(item);

  return (
    <div
      data-item-id={item.itemId}
      data-item-status={item.status}
      className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 py-0.5 text-[13px]"
    >
      <StatusIcon
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-3.5 w-3.5 text-zinc-600",
          item.status === "active" &&
            "text-zinc-400 motion-safe:animate-pulse motion-reduce:animate-none",
          item.status === "completed" && "text-zinc-500",
          item.status === "failed" && "text-zinc-400",
          item.status === "interrupted" && "text-zinc-500",
        )}
      />
      <div className="min-w-0 text-zinc-500">
        <span className="text-zinc-400">{label}</span>
        {isCommentary && text ? (
          <div className="mt-1 max-h-24 overflow-hidden text-zinc-300">
            <MarkdownMessageContent content={text} />
          </div>
        ) : text && text !== label ? (
          <span className="ml-2 break-words text-zinc-300">{text}</span>
        ) : null}
        {item.inputSummary &&
        item.inputSummary !== text &&
        item.inputSummary !== label ? (
          <span className="ml-2 break-words text-zinc-300">
            {item.inputSummary}
          </span>
        ) : null}
        {item.outputSummary && item.outputSummary !== text ? (
          <span className="ml-2 text-zinc-500">{item.outputSummary}</span>
        ) : null}
        {item.kind === "plan" && item.planSteps.length > 0 ? (
          <span className="ml-2 text-zinc-500">
            {
              item.planSteps.filter((step) => step.status === "completed")
                .length
            }
            /{item.planSteps.length} steps
          </span>
        ) : null}
      </div>
    </div>
  );
}

function resolveItemIcon(item: WorkflowItem): LucideIcon {
  if (item.status === "failed") return CircleAlert;
  if (item.status === "interrupted") return Square;
  if (item.status === "completed" && item.kind === "commentary") return Check;
  switch (item.toolFamily) {
    case "read":
      return BookOpen;
    case "search":
      return Search;
    case "edit":
      return FilePenLine;
    case "shell":
      return Terminal;
    case "git":
      return GitBranch;
    case "web":
    case "browser":
      return Globe;
    default:
      return Wrench;
  }
}

function humanizeKind(kind: WorkflowItem["kind"]): string {
  return kind.replaceAll("_", " ");
}
