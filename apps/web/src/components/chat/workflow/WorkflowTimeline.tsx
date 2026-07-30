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
import { ThinkingIndicator } from "./ThinkingIndicator.js";

interface WorkflowTimelineProps {
  segments: readonly ToolActivitySegment[];
  showThinkingState: boolean;
  onArtifactOpen?: (path: string, content: string) => void;
}

export function WorkflowTimeline({
  segments,
  showThinkingState,
  onArtifactOpen,
}: WorkflowTimelineProps) {
  return (
    <div className="space-y-3" data-testid="workflow-tool-viewport">
      {segments.map((segment) => (
        <WorkflowSegment
          key={segment.key}
          segment={segment}
          onArtifactOpen={onArtifactOpen}
        />
      ))}
      {showThinkingState ? <ThinkingIndicator /> : null}
    </div>
  );
}

function WorkflowSegment({
  segment,
  onArtifactOpen,
}: {
  segment: ToolActivitySegment;
  onArtifactOpen?: (path: string, content: string) => void;
}) {
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
      <div className="py-1 text-[15px] leading-7 text-zinc-100">
        <MarkdownMessageContent content={itemDisplayText(commentary) ?? ""} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {segment.reasoning ? (
        <div className="text-[15px] leading-7 text-zinc-100">
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
              <WorkflowItemRow
                key={item.itemId}
                item={item}
                onArtifactOpen={onArtifactOpen}
              />
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
        className="group flex items-center gap-2 py-1 text-sm text-zinc-500 transition hover:text-zinc-100"
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
        <div className="ml-2 mt-1 border-l border-zinc-800 py-1 pl-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowItemRow({
  item,
  reasoning = false,
  onArtifactOpen,
}: {
  item: WorkflowItem;
  reasoning?: boolean;
  onArtifactOpen?: (path: string, content: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = itemDisplayText(item);
  const isCommentary = item.kind === "commentary";
  const isInspectable =
    !isCommentary &&
    item.kind !== "reasoning" &&
    item.kind !== "assistant_message" &&
    item.kind !== "user_message";
  const label = reasoning
    ? (item.safeSummary ?? "Thinking")
    : resolveItemLabel(item);
  const StatusIcon = resolveItemIcon(item);
  const detailLines = [
    item.detail,
    item.inputSummary,
    item.outputSummary,
    item.text,
  ].filter(
    (value, index, values): value is string =>
      Boolean(value?.trim()) &&
      value !== label &&
      values.indexOf(value) === index,
  );
  const preview = detailLines[0] ?? null;

  return (
    <div
      data-item-id={item.itemId}
      data-item-status={item.status}
      className="group py-0.5 text-[13px]"
    >
      <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2">
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
        {isInspectable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`View details for ${label}`}
            onClick={() => {
              if (
                item.toolFamily === "read" &&
                item.filePath &&
                item.outputContent &&
                onArtifactOpen
              ) {
                onArtifactOpen(item.filePath, item.outputContent);
                return;
              }
              setExpanded((current) => !current);
            }}
            className="min-w-0 text-left text-zinc-500 transition-colors hover:text-zinc-100"
          >
            <span>{label}</span>
            {preview ? (
              <span className="ml-2 break-words text-zinc-400">{preview}</span>
            ) : null}
            {item.status === "failed" ? (
              <span className="ml-2 text-zinc-500">failed</span>
            ) : null}
            <ChevronDown
              className={cn(
                "ml-1 inline h-3 w-3 transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
        ) : (
          <div className="min-w-0 text-zinc-100">
            <span>{label}</span>
            {isCommentary && text ? (
              <div className="mt-1 max-h-24 overflow-hidden">
                <MarkdownMessageContent content={text} />
              </div>
            ) : null}
          </div>
        )}
      </div>
      {item.toolFamily === "edit" && item.diffPreview ? (
        <InlineEditPreview item={item} />
      ) : null}
      {item.toolFamily === "shell" && (item.command || item.outputContent) ? (
        <InlineShellOutput item={item} />
      ) : null}
      {expanded &&
      detailLines.length > 0 &&
      !item.diffPreview &&
      item.toolFamily !== "shell" ? (
        <div className="ml-6 mt-1 max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-xs leading-5 text-zinc-400">
          {detailLines.map((line) => (
            <div key={line} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))}
        </div>
      ) : null}
      {item.kind === "plan" && item.planSteps.length > 0 ? (
        <div className="ml-6 text-zinc-500">
          {item.planSteps.filter((step) => step.status === "completed").length}/
          {item.planSteps.length} steps
        </div>
      ) : null}
    </div>
  );
}

function InlineEditPreview({ item }: { item: WorkflowItem }) {
  return (
    <div className="ml-6 mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-[#0c0c0e]">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs">
        <span className="truncate font-mono text-zinc-300">
          {item.filePath ?? "Edited file"}
        </span>
        <span className="shrink-0 font-mono">
          <span className="text-emerald-400">+{item.additions ?? 0}</span>
          <span className="ml-2 text-red-400">-{item.deletions ?? 0}</span>
        </span>
      </div>
      <div className="max-h-64 overflow-auto font-mono text-xs leading-5">
        {item.diffPreview?.split("\n").map((line, index) => (
          <div
            key={`${index}:${line}`}
            className={cn(
              "whitespace-pre-wrap break-words px-3",
              line.startsWith("+")
                ? "bg-emerald-950/35 text-emerald-300"
                : line.startsWith("-")
                  ? "bg-red-950/35 text-red-300"
                  : "text-zinc-400",
            )}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function InlineShellOutput({ item }: { item: WorkflowItem }) {
  return (
    <div className="ml-6 mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-[#0c0c0e] px-3 py-2 font-mono text-xs leading-5">
      {item.command ? (
        <div className="text-zinc-200">
          <span className="mr-2 text-zinc-600">$</span>
          {item.command}
        </div>
      ) : null}
      {item.outputContent ? (
        <pre className="mt-1 whitespace-pre-wrap break-words text-zinc-400">
          {item.outputContent}
        </pre>
      ) : null}
    </div>
  );
}

function resolveItemLabel(item: WorkflowItem): string {
  const target = item.filePath ?? item.inputSummary;
  if (target && item.toolFamily === "read") {
    return `${item.status === "active" ? "Reading" : "Read"} ${target}`;
  }
  if (target && item.toolFamily === "edit") {
    return `${item.status === "active" ? "Editing" : "Edited"} ${target}`;
  }
  if (item.toolFamily === "shell") {
    return item.status === "active" ? "Running command" : "Ran command";
  }
  return item.safeSummary ?? item.toolFamily ?? humanizeKind(item.kind);
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
