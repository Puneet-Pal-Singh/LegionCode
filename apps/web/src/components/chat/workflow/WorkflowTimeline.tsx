import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  CircleAlert,
  FilePenLine,
  GitBranch,
  Globe,
  Images,
  Search,
  Square,
  Terminal,
  Wrench,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  buildActiveWorkflowTrace,
  buildSegmentTitle,
  type ToolActivitySegment,
  type WorkflowItem,
} from "@repo/platform-client-sdk";
import { MarkdownMessageContent } from "../chat-message/MessageContent.js";
import { cn } from "../../../lib/utils.js";
import { itemDisplayText } from "./workflowPresentation.js";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";
import type { ArtifactOpenHandler } from "../artifactOpen.js";
import { parseReadFileOutput } from "../../../services/lifecycle/ReadFileOutputParser.js";
import { buildDiffContentFromTurnDiff } from "../../../services/lifecycle/TurnDiffPatchParser.js";
import { DiffViewer } from "../../diff/DiffViewer.js";

// Parent activity groups are intentionally airy enough to read as separate
// phases in the trace. Once a group is opened, its child calls use a shorter
// cadence so the list reads as one compact execution rather than a second
// stack of cards.
const WORKFLOW_PARENT_CADENCE = "min-h-8 py-1.5 text-sm leading-5";
const WORKFLOW_CHILD_CADENCE = "min-h-6 py-0.5 text-sm leading-5";

interface WorkflowTimelineProps {
  segments: readonly ToolActivitySegment[];
  turnDiff: TurnDiffPayload | null;
  showThinkingState: boolean;
  onArtifactOpen?: ArtifactOpenHandler;
}

export function WorkflowTimeline({
  segments,
  turnDiff,
  showThinkingState,
  onArtifactOpen,
}: WorkflowTimelineProps) {
  const activeTrace = showThinkingState
    ? buildActiveWorkflowTrace(segments)
    : null;
  return (
    <div className="space-y-3" data-testid="workflow-tool-viewport">
      {segments.map((segment) =>
        activeTrace?.consumedSegmentKeys.includes(segment.key) ? null : (
          <WorkflowSegment
            key={segment.key}
            segment={segment}
            turnDiff={turnDiff}
            onArtifactOpen={onArtifactOpen}
          />
        ),
      )}
      {showThinkingState ? (
        <ActiveWorkflowTrace
          key="active-workflow-trace"
          title={activeTrace?.title ?? "Thinking through the next step"}
          children={activeTrace?.children ?? []}
          turnDiff={turnDiff}
          onArtifactOpen={onArtifactOpen}
        />
      ) : null}
    </div>
  );
}

function ActiveWorkflowTrace({
  title,
  children,
  turnDiff,
  onArtifactOpen,
}: {
  title: string;
  children: readonly WorkflowItem[];
  turnDiff: TurnDiffPayload | null;
  onArtifactOpen?: ArtifactOpenHandler;
}) {
  return (
    <ActivityDisclosure
      title={title}
      active
      hasChildren={children.length > 0}
      defaultExpanded={children.some((item) => item.kind === "commentary")}
      titleTestId="active-workflow-title"
    >
      {children.map((item) => (
        <WorkflowItemRow
          key={item.itemId}
          item={item}
          turnDiff={turnDiff}
          nested
          onArtifactOpen={onArtifactOpen}
        />
      ))}
    </ActivityDisclosure>
  );
}

function WorkflowSegment({
  segment,
  turnDiff,
  onArtifactOpen,
}: {
  segment: ToolActivitySegment;
  turnDiff: TurnDiffPayload | null;
  onArtifactOpen?: ArtifactOpenHandler;
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
    <div className="space-y-1">
      {segment.reasoning && segment.children.length === 0 ? (
        <div className="text-[15px] leading-7 text-zinc-100">
          <span
            className={segment.isActive ? "turn-lifecycle-shimmer" : undefined}
          >
            {itemDisplayText(segment.reasoning) ?? "Thinking"}
          </span>
        </div>
      ) : null}
      {segment.children.length > 0 ? (
        segment.isActive || segment.reasoning || segment.children.length > 1 ? (
          <ActivityDisclosure
            title={buildSegmentTitle(segment)}
            active={segment.isActive}
            hasChildren
            defaultExpanded={segment.children.some(
              (item) => item.kind === "commentary",
            )}
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
              className="max-h-60 space-y-0 overflow-y-auto pr-2"
            >
              {segment.children.map((item) => (
                <WorkflowItemRow
                  key={item.itemId}
                  item={item}
                  turnDiff={turnDiff}
                  nested
                  onArtifactOpen={onArtifactOpen}
                />
              ))}
            </div>
          </ActivityDisclosure>
        ) : (
          <WorkflowItemRow
            item={segment.children[0]!}
            turnDiff={turnDiff}
            onArtifactOpen={onArtifactOpen}
          />
        )
      ) : null}
    </div>
  );
}

function ActivityDisclosure({
  title,
  active,
  hasChildren,
  defaultExpanded = false,
  titleTestId,
  children,
}: {
  title: string;
  active: boolean;
  hasChildren: boolean;
  defaultExpanded?: boolean;
  titleTestId?: string;
  children: ReactNode;
}) {
  // Activity is deliberately closed by default. Provider-visible commentary
  // is the exception: it is part of the user-facing transcript and must be
  // visible without an inspection click even when grouped with tool calls.
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div>
      <button
        type="button"
        aria-expanded={hasChildren ? expanded : undefined}
        aria-disabled={!hasChildren}
        data-testid="activity-disclosure-row"
        onClick={() => {
          if (hasChildren) setExpanded((current) => !current);
        }}
        className={cn(
          "group flex items-center gap-2 text-zinc-500 transition hover:text-zinc-100",
          WORKFLOW_PARENT_CADENCE,
        )}
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        <span
          data-testid={titleTestId}
          className={cn(
            "first-letter:uppercase",
            active && "turn-lifecycle-shimmer",
          )}
        >
          {title}
        </span>
        {hasChildren ? (
          <ChevronRight
            data-testid="activity-disclosure-chevron"
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {hasChildren && expanded ? (
        <div className="min-w-0">{children}</div>
      ) : null}
    </div>
  );
}

function WorkflowItemRow({
  item,
  turnDiff,
  reasoning = false,
  onArtifactOpen,
  nested = false,
}: {
  item: WorkflowItem;
  turnDiff: TurnDiffPayload | null;
  reasoning?: boolean;
  onArtifactOpen?: ArtifactOpenHandler;
  nested?: boolean;
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
  const preview =
    detailLines.find(
      (line) => line !== item.filePath && line !== item.command,
    ) ?? null;

  return (
    <div
      data-item-id={item.itemId}
      data-item-status={item.status}
      className={cn(
        "group",
        nested ? WORKFLOW_CHILD_CADENCE : WORKFLOW_PARENT_CADENCE,
      )}
    >
      <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2">
        <WorkflowStatusIcon item={item} />
        {isInspectable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`View details for ${label}`}
            onClick={() => {
              if (
                item.toolFamily === "read" &&
                item.filePath &&
                onArtifactOpen
              ) {
                const parsed = parseReadFileOutput(item.outputContent ?? "");
                onArtifactOpen(
                  item.filePath,
                  parsed?.content ?? item.outputContent ?? "",
                  {
                    refreshFromWorkspace:
                      parsed?.returnedLines === 0 ||
                      !item.outputContent?.trim(),
                    startingLineNumber: parsed ? parsed.offset + 1 : 1,
                  },
                );
                return;
              }
              setExpanded((current) => !current);
            }}
            className="min-w-0 text-left text-zinc-500 transition-colors hover:text-white"
          >
            <span
              className={
                item.status === "active" ? "turn-lifecycle-shimmer" : undefined
              }
            >
              {label}
            </span>
            {preview ? (
              <span className="ml-2 break-words text-zinc-400 transition-colors group-hover:text-white">
                {preview}
              </span>
            ) : null}
            {item.toolFamily === "edit" &&
            (item.additions != null || item.deletions != null) ? (
              <span className="ml-2 inline-flex gap-1.5 font-mono text-xs font-normal">
                <span className="text-emerald-400">+{item.additions ?? 0}</span>
                <span className="text-red-400">-{item.deletions ?? 0}</span>
              </span>
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
      {expanded && item.toolFamily === "edit" && item.diffPreview ? (
        <InlineEditPreview item={item} turnDiff={turnDiff} />
      ) : null}
      {expanded &&
      item.toolFamily === "shell" &&
      (item.command || item.outputContent) ? (
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

function InlineEditPreview({
  item,
  turnDiff,
}: {
  item: WorkflowItem;
  turnDiff: TurnDiffPayload | null;
}) {
  const diff =
    turnDiff && item.filePath
      ? buildDiffContentFromTurnDiff(turnDiff, item.filePath)
      : null;

  if (diff) {
    return (
      <div className="mt-2 min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-black">
        <DiffViewer
          diff={diff}
          className="max-h-80 min-w-0"
          layout="stacked"
          wordWrap={false}
          showHeader={false}
          showFileSummary
          fileSummaryLayout="inline"
        />
      </div>
    );
  }

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-[#0c0c0e]">
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
    <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-[#0c0c0e] px-3 py-2 font-mono text-xs leading-5 sm:ml-6">
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
    if (item.editChange === "created") {
      return `${item.status === "active" ? "Creating" : "Created"} ${target}`;
    }
    return `${item.status === "active" ? "Editing" : "Edited"} ${target}`;
  }
  if (item.toolFamily === "shell") {
    return item.status === "active" ? "Running command" : "Ran command";
  }
  if (item.toolFamily === "image") {
    return item.safeSummary ?? (item.status === "active" ? "Viewing images" : "Viewed images");
  }
  return item.safeSummary ?? item.toolFamily ?? humanizeKind(item.kind);
}

function WorkflowStatusIcon({ item }: { item: WorkflowItem }) {
  const className = cn(
    "mt-0.5 h-4 w-4 text-zinc-600",
    item.status === "active" &&
      "text-zinc-400 motion-safe:animate-pulse motion-reduce:animate-none",
    item.status === "completed" && "text-zinc-500",
    item.status === "failed" && "text-zinc-400",
    item.status === "interrupted" && "text-zinc-500",
  );
  if (item.status === "failed") {
    return <CircleAlert aria-hidden="true" className={className} />;
  }
  if (item.status === "interrupted") {
    return <Square aria-hidden="true" className={className} />;
  }
  if (item.status === "completed" && item.kind === "commentary") {
    return <Check aria-hidden="true" className={className} />;
  }
  switch (item.toolFamily) {
    case "read":
      return <BookOpen aria-hidden="true" className={className} />;
    case "search":
      return <Search aria-hidden="true" className={className} />;
    case "edit":
      return <FilePenLine aria-hidden="true" className={className} />;
    case "shell":
      return <Terminal aria-hidden="true" className={className} />;
    case "git":
      return <GitBranch aria-hidden="true" className={className} />;
    case "web":
    case "browser":
      return <Globe aria-hidden="true" className={className} />;
    case "image":
      return <Images aria-hidden="true" className={className} />;
    default:
      return <Wrench aria-hidden="true" className={className} />;
  }
}

function humanizeKind(kind: WorkflowItem["kind"]): string {
  return kind.replaceAll("_", " ");
}
