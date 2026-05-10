import {
  ArrowUpRight,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Message } from "@ai-sdk/react";
import type { DiffContent, DiffLine, FileStatus } from "@repo/shared-types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactPreview } from "./ArtifactPreview";
import { cn } from "../../lib/utils";
import type { ChatMessageMetadata } from "./messageMetadata";

interface ChangedFilesSummary {
  files: FileStatus[];
  loadFileDiff?: (file: FileStatus) => Promise<DiffContent>;
}

interface ChangeLineStats {
  additions: number | null;
  deletions: number | null;
}

interface ChangedFileDiffState {
  loading: boolean;
  diff?: DiffContent;
  error?: string;
}

type InlineDiffRow =
  | {
      kind: "line";
      key: string;
      line: DiffLine;
    }
  | {
      kind: "separator";
      key: string;
    };

interface InlineDiffSegment {
  key: string;
  lines: Array<{
    key: string;
    line: DiffLine;
  }>;
  sortLineNumber: number;
  originalIndex: number;
}

interface ChatMessageProps {
  message: Message;
  metadata?: ChatMessageMetadata;
  onArtifactOpen?: (path: string, content: string) => void;
  onReviewOpen?: () => void;
  changedFilesSummary?: ChangedFilesSummary;
}

export function ChatMessage({
  message,
  metadata,
  onArtifactOpen,
  onReviewOpen,
  changedFilesSummary,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [isThinkingVisible, setIsThinkingVisible] = useState(false);

  const { content, thinkingBlocks } = useMemo(() => {
    const rawContent: unknown = message.content;
    let extractedText = "";
    const extractedThinking: string[] = [];

    if (typeof rawContent === "string") {
      extractedText = rawContent;
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const record = part as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        const text = typeof record.text === "string" ? record.text : "";
        const reasoning =
          typeof record.reasoning === "string" ? record.reasoning : "";

        if (type === "reasoning" || type === "thinking") {
          const block = (text || reasoning).trim();
          if (block) {
            extractedThinking.push(block);
          }
          continue;
        }

        if (text) {
          extractedText += text;
        }
      }
    }

    if (message.role !== "assistant") {
      return {
        content: extractedText.trim(),
        thinkingBlocks: [],
      };
    }

    const parsedText = parseThinkingTags(extractedText);
    const dedupedThinking = Array.from(
      new Set(
        [...extractedThinking, ...parsedText.thinkingBlocks]
          .map((block) => block.trim())
          .filter((block) => block.length > 0),
      ),
    );

    return {
      content: parsedText.visibleContent.trim(),
      thinkingBlocks: dedupedThinking,
    };
  }, [message.content, message.role]);
  const displayContent = useMemo(() => {
    if (isUser || !changedFilesSummary || !content) {
      return content;
    }

    return stripAssistantChangeCounts(content);
  }, [changedFilesSummary, content, isUser]);

  const metadataText = useMemo(
    () => formatMetadataText(metadata, isUser),
    [isUser, metadata],
  );
  const canCopyContent = displayContent.length > 0;
  const handleCopy = useCallback(async () => {
    if (!canCopyContent || typeof navigator === "undefined") {
      return;
    }
    try {
      await navigator.clipboard.writeText(displayContent);
    } catch (error) {
      console.warn("[chat/message] Failed to copy message", error);
    }
  }, [canCopyContent, displayContent]);

  return (
    <div
      className={cn(
        "group flex gap-4 w-full",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Message Content */}
      <div className={cn("max-w-4xl", isUser ? "text-right" : "flex-1")}>
        {/* User message bubble */}
        {isUser && displayContent && (
          <div className="inline-block bg-[#262626] text-white px-4 py-2.5 rounded-2xl text-sm leading-relaxed">
            <MarkdownMessageContent content={displayContent} isUser />
          </div>
        )}

        {/* Assistant message */}
        {!isUser && (displayContent || thinkingBlocks.length > 0) && (
          <div className="space-y-3">
            {thinkingBlocks.length > 0 && (
              <div className="rounded-lg border border-zinc-800/90 bg-zinc-950/70">
                <button
                  type="button"
                  onClick={() => setIsThinkingVisible((current) => !current)}
                  className="w-full cursor-pointer select-none px-3 py-2 text-left text-xs font-medium text-zinc-300 hover:text-zinc-100"
                >
                  {isThinkingVisible ? "Hide thinking" : "Show thinking"}
                </button>
                {isThinkingVisible && (
                  <div className="space-y-3 border-t border-zinc-800/80 px-3 py-3">
                    {thinkingBlocks.map((block, index) => (
                      <pre
                        key={`thinking-${index}`}
                        className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-400"
                      >
                        {block}
                      </pre>
                    ))}
                  </div>
                )}
              </div>
            )}

            {displayContent && <MarkdownMessageContent content={displayContent} />}
          </div>
        )}

        {/* Tool Invocations */}
        {message.toolInvocations
          ?.filter((toolInvocation) => {
            // ONLY show major UI artifacts. Everything else is hidden behind 'Thinking' status.
            return toolInvocation.toolName === "create_code_artifact";
          })
          .map((toolInvocation, index) => {
            const toolName = toolInvocation.toolName;
            const status = toolInvocation.state;
            const args = toolInvocation.args as Record<
              string,
              string | undefined
            >;
            const key = toolInvocation.toolCallId || `tool-${index}`;
            const path = args?.path || "untitled";
            const artifactContent = args?.content || "";

            if (toolName === "create_code_artifact" && artifactContent) {
              return (
                <ArtifactPreview
                  key={key}
                  title={path}
                  content={artifactContent}
                  status={status}
                  onOpen={() => onArtifactOpen?.(path, artifactContent)}
                />
              );
            }

            return null;
          })}

        {!isUser && changedFilesSummary && changedFilesSummary.files.length > 0 && (
          <ChangedFilesCard
            files={changedFilesSummary.files}
            loadFileDiff={changedFilesSummary.loadFileDiff}
            onReviewOpen={onReviewOpen}
          />
        )}

        {metadataText && (
          <div
            className={cn(
              "mt-2 flex items-center gap-2 text-xs text-zinc-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {!isUser && canCopyContent && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="rounded p-1 text-zinc-500 hover:text-zinc-300"
                aria-label="Copy message"
              >
                <CopyIcon />
              </button>
            )}
            <span>{metadataText}</span>
            {isUser && canCopyContent && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="rounded p-1 text-zinc-500 hover:text-zinc-300"
                aria-label="Copy message"
              >
                <CopyIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangedFilesCard({
  files,
  loadFileDiff,
  onReviewOpen,
}: {
  files: FileStatus[];
  loadFileDiff?: (file: FileStatus) => Promise<DiffContent>;
  onReviewOpen?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const diffStates = useChangedFileDiffStates(files, loadFileDiff);
  const totals = calculateChangedFileTotals(files, diffStates);
  const fileCountLabel = files.length === 1 ? "file changed" : "files changed";

  const togglePath = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-zinc-800/90 bg-zinc-950/65 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      {/* Header */}
      <div className={cn("flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-2.5", !isExpanded && "border-b-0")}>
        <div className="flex items-center gap-3 text-sm font-semibold text-zinc-100">
          <span>
            {files.length} {fileCountLabel}
          </span>
          {files.length > 1 && (
            <ChangeStats additions={totals.additions} deletions={totals.deletions} />
          )}
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
            onClick={onReviewOpen}
          >
            <span>Review</span>
            <ArrowUpRight size={14} />
          </button>
          <button
            type="button"
            className="text-zinc-500 transition-colors hover:text-zinc-300"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? "Collapse files" : "Expand files"}
          >
            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Files List */}
      {isExpanded && (
        <div className="divide-y divide-zinc-800/80">
          {files.map((file) => (
            <ChangedFileRow
              key={file.path}
              file={file}
              diffState={diffStates[file.path]}
              isExpanded={expandedPaths.has(file.path)}
              onToggle={() => togglePath(file.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function useChangedFileDiffStates(
  files: FileStatus[],
  loadFileDiff: ((file: FileStatus) => Promise<DiffContent>) | undefined,
): Record<string, ChangedFileDiffState> {
  const [diffStates, setDiffStates] = useState<
    Record<string, ChangedFileDiffState>
  >({});

  useEffect(() => {
    if (!loadFileDiff) {
      return;
    }

    let cancelled = false;
    files.forEach((file) => {
      setDiffStateLoading(setDiffStates, file.path);
      void loadFileDiff(file)
        .then((diff) => {
          if (!cancelled) {
            setDiffStateResult(setDiffStates, file.path, diff);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setDiffStateError(setDiffStates, file.path, error);
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [files, loadFileDiff]);

  return diffStates;
}

function setDiffStateLoading(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: current[path] ?? { loading: true },
  }));
}

function setDiffStateResult(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
  diff: DiffContent,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: { loading: false, diff },
  }));
}

function setDiffStateError(
  setDiffStates: Dispatch<SetStateAction<Record<string, ChangedFileDiffState>>>,
  path: string,
  error: unknown,
): void {
  setDiffStates((current) => ({
    ...current,
    [path]: {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    },
  }));
}

function ChangedFileRow({
  file,
  diffState,
  isExpanded,
  onToggle,
}: {
  file: FileStatus;
  diffState?: ChangedFileDiffState;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const fileNameParts = splitPathForDisplay(file.path);
  const stats = getFileStats(file, diffState);

  return (
    <div className="border-b border-zinc-800/80 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-900/80"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} changes for ${file.path}`}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-400">
          {fileNameParts.directory}
          <span className="font-semibold text-zinc-100">{fileNameParts.name}</span>
        </span>
        <ChangeStats additions={stats.additions} deletions={stats.deletions} />
        <span className="text-zinc-600" aria-hidden="true">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded ? <ChangedFileInlineDiff diffState={diffState} /> : null}
    </div>
  );
}

function ChangedFileInlineDiff({
  diffState,
}: {
  diffState?: ChangedFileDiffState;
}) {
  if (!diffState || diffState.loading) {
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        Loading diff...
      </div>
    );
  }
  if (diffState.error) {
    return (
      <div className="border-t border-red-500/30 px-4 py-4 text-sm text-red-300">
        {diffState.error}
      </div>
    );
  }
  if (!diffState.diff) {
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        No diff available
      </div>
    );
  }
  return <InlineDiffViewer diff={diffState.diff} />;
}

function InlineDiffViewer({ diff }: { diff: DiffContent }) {
  if (diff.isBinary) {
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        Binary file changed
      </div>
    );
  }

  return (
    <div className="max-h-[28rem] overflow-auto border-t border-zinc-800 bg-black/70">
      {diff.hunks.length === 0 || !hasRenderableChangedLines(diff) ? (
        <div className="px-4 py-4 text-sm text-zinc-500">No line changes</div>
      ) : (
        buildInlineDiffRows(diff).map((row) =>
          row.kind === "line" ? (
            <InlineDiffLine key={row.key} line={row.line} />
          ) : (
            <InlineDiffSeparator key={row.key} />
          ),
        )
      )}
    </div>
  );
}

function InlineDiffLine({ line }: { line: DiffLine }) {
  const lineStyle = getInlineDiffLineStyle(line.type);
  const lineNumber = getInlineDiffLineNumber(line);
  return (
    <div
      className={cn(
        "flex min-w-0 border-l-2 font-mono text-xs",
        lineStyle.container,
      )}
    >
      <span
        className={cn(
          "w-14 shrink-0 bg-zinc-900/60 px-2 py-1 text-right",
          lineStyle.number,
        )}
      >
        {lineNumber}
      </span>
      <pre
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words px-3 py-1",
          lineStyle.text,
        )}
      >
        {line.content}
      </pre>
    </div>
  );
}

function getInlineDiffLineNumber(line: DiffLine): string {
  const lineNumber = getInlineDiffSortLineNumber(line);
  return lineNumber === null ? "" : String(lineNumber);
}

function InlineDiffSeparator() {
  return (
    <div className="flex min-w-0 items-center bg-zinc-950/90">
      <span className="w-14 shrink-0 bg-zinc-900/60 px-2 py-2" />
      <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2">
        <span className="h-px flex-1 bg-zinc-800/90" />
        <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-zinc-500">
          ...
        </span>
        <span className="h-px flex-1 bg-zinc-800/90" />
      </div>
    </div>
  );
}

function hasRenderableChangedLines(diff: DiffContent): boolean {
  return diff.hunks.some((hunk) =>
    hunk.lines.some((line) => line.type !== "unchanged"),
  );
}

function buildInlineDiffRows(
  diff: DiffContent,
  contextLineCount = 3,
): InlineDiffRow[] {
  const sortedSegments = buildInlineDiffSegments(diff, contextLineCount).sort(
    compareInlineDiffSegments,
  );

  return sortedSegments.flatMap((segment, index) => {
    const separator: InlineDiffRow[] =
      index === 0 ? [] : [{ kind: "separator", key: `separator-${segment.key}` }];
    const lines = segment.lines.map<InlineDiffRow>((line) => ({
      kind: "line",
      key: line.key,
      line: line.line,
    }));
    return [...separator, ...lines];
  });
}

function buildInlineDiffSegments(
  diff: DiffContent,
  contextLineCount: number,
): InlineDiffSegment[] {
  const segments: InlineDiffSegment[] = [];
  let originalIndex = 0;
  diff.hunks.forEach((hunk, hunkIndex) => {
    const ranges = buildContextRanges(hunk.lines, contextLineCount);
    ranges.forEach((range, rangeIndex) => {
      const segmentLines: InlineDiffSegment["lines"] = [];
      for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
        const line = hunk.lines[lineIndex];
        if (!line) {
          continue;
        }
        segmentLines.push({
          key: `line-${hunkIndex}-${lineIndex}`,
          line,
        });
      }
      const splitSegments = splitInlineDiffSegmentLines(segmentLines);
      splitSegments.forEach((lines, splitIndex) => {
        segments.push({
          key: `${hunkIndex}-${rangeIndex}-${splitIndex}`,
          lines,
          sortLineNumber: getSegmentSortLineNumber(lines),
          originalIndex,
        });
        originalIndex += 1;
      });
    });
  });

  return segments;
}

function splitInlineDiffSegmentLines(
  lines: InlineDiffSegment["lines"],
): Array<InlineDiffSegment["lines"]> {
  const segments: Array<InlineDiffSegment["lines"]> = [];
  let currentSegment: InlineDiffSegment["lines"] = [];
  let previousLineNumber: number | null = null;

  lines.forEach((line) => {
    const currentLineNumber = getInlineDiffSortLineNumber(line.line);
    if (
      currentSegment.length > 0 &&
      previousLineNumber !== null &&
      currentLineNumber !== null &&
      currentLineNumber < previousLineNumber
    ) {
      segments.push(currentSegment);
      currentSegment = [];
    }

    currentSegment.push(line);
    if (currentLineNumber !== null) {
      previousLineNumber = currentLineNumber;
    }
  });

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function compareInlineDiffSegments(
  first: InlineDiffSegment,
  second: InlineDiffSegment,
): number {
  if (first.sortLineNumber !== second.sortLineNumber) {
    return first.sortLineNumber - second.sortLineNumber;
  }

  return first.originalIndex - second.originalIndex;
}

function getSegmentSortLineNumber(lines: InlineDiffSegment["lines"]): number {
  return lines.reduce((minimumLineNumber, line) => {
    const lineNumber = getInlineDiffSortLineNumber(line.line);
    if (lineNumber === null) {
      return minimumLineNumber;
    }
    return Math.min(minimumLineNumber, lineNumber);
  }, Number.MAX_SAFE_INTEGER);
}

function getInlineDiffSortLineNumber(line: DiffLine): number | null {
  if (line.type === "deleted") {
    return line.oldLineNumber ?? null;
  }

  return line.newLineNumber ?? line.oldLineNumber ?? null;
}

function buildContextRanges(
  lines: DiffLine[],
  contextLineCount: number,
): Array<{ start: number; end: number }> {
  const changedLineIndexes = lines.flatMap((line, index) =>
    line.type === "unchanged" ? [] : [index],
  );

  if (changedLineIndexes.length === 0) {
    return [];
  }

  const ranges = changedLineIndexes.map((index) => ({
    start: Math.max(0, index - contextLineCount),
    end: Math.min(lines.length - 1, index + contextLineCount),
  }));

  return ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
      return merged;
    }

    previous.end = Math.max(previous.end, range.end);
    return merged;
  }, []);
}

function ChangeStats({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold">
      <span className="text-emerald-400">+{additions ?? "…"}</span>
      <span className="text-red-400">-{deletions ?? "…"}</span>
    </span>
  );
}

function calculateChangedFileTotals(
  files: FileStatus[],
  diffStates: Record<string, ChangedFileDiffState>,
): ChangeLineStats {
  return files.reduce<ChangeLineStats>(
    (totals, file) => {
      const stats = getFileStats(file, diffStates[file.path]);
      if (stats.additions === null || stats.deletions === null) {
        return { additions: null, deletions: null };
      }
      if (totals.additions === null || totals.deletions === null) {
        return totals;
      }
      return {
        additions: totals.additions + stats.additions,
        deletions: totals.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

function getFileStats(
  file: FileStatus,
  diffState?: ChangedFileDiffState,
): ChangeLineStats {
  if (diffState?.diff) {
    return calculateDiffStats(diffState.diff);
  }

  if (diffState?.loading && file.additions === 0 && file.deletions === 0) {
    return { additions: null, deletions: null };
  }

  if (!diffState?.diff) {
    return { additions: file.additions, deletions: file.deletions };
  }

  return calculateDiffStats(diffState.diff);
}

function calculateDiffStats(diff: DiffContent): ChangeLineStats {
  return diff.hunks.reduce(
    (totals, hunk) => ({
      additions:
        totals.additions +
        hunk.lines.filter((line) => line.type === "added").length,
      deletions:
        totals.deletions +
        hunk.lines.filter((line) => line.type === "deleted").length,
    }),
    { additions: 0, deletions: 0 },
  );
}

function getInlineDiffLineStyle(lineType: DiffLine["type"]): {
  container: string;
  number: string;
  text: string;
} {
  if (lineType === "added") {
    return {
      container: "border-l-emerald-400 bg-emerald-500/14",
      number: "text-emerald-400",
      text: "text-emerald-200",
    };
  }
  if (lineType === "deleted") {
    return {
      container: "border-l-red-400 bg-red-500/14",
      number: "text-red-400",
      text: "text-red-200",
    };
  }
  return {
    container: "border-l-transparent bg-black",
    number: "text-zinc-500",
    text: "text-zinc-300",
  };
}

function splitPathForDisplay(path: string): { directory: string; name: string } {
  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return { directory: "", name: path };
  }

  return {
    directory: path.slice(0, lastSlashIndex + 1),
    name: path.slice(lastSlashIndex + 1),
  };
}

function stripAssistantChangeCounts(content: string): string {
  return content.replace(/ \(\+\d+ -\d+\)/g, "");
}

function formatMetadataText(
  metadata: ChatMessageMetadata | undefined,
  isUser: boolean,
): string {
  if (!metadata) {
    return "";
  }

  if (isUser) {
    return metadata.timeLabel ?? "";
  }

  return [
    metadata.modeLabel,
    metadata.modelLabel,
    metadata.timeLabel,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" · ");
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

interface MarkdownMessageContentProps {
  content: string;
  isUser?: boolean;
}

function MarkdownMessageContent({
  content,
  isUser = false,
}: MarkdownMessageContentProps) {
  const remarkPlugins = isUser
    ? [remarkGfm, remarkShortenUserFileMentions]
    : [remarkGfm];

  return (
    <div
      className={cn(
        "break-words text-sm leading-relaxed",
        "[&_p]:m-0 [&_p+*]:mt-3",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_hr]:my-4 [&_hr]:border-zinc-700/60",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_code]:rounded [&_code]:border [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left",
        "[&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold",
        "[&_td]:border [&_td]:px-2 [&_td]:py-1",
        isUser
          ? "text-white [&_blockquote]:border-zinc-400/60 [&_code]:border-zinc-700/85 [&_code]:bg-zinc-900/92 [&_pre]:bg-zinc-900/70 [&_th]:border-zinc-500/70 [&_td]:border-zinc-500/60"
          : "text-zinc-100 [&_blockquote]:border-zinc-600/80 [&_code]:border-zinc-700/90 [&_code]:bg-zinc-900/88 [&_pre]:bg-zinc-950/80 [&_th]:border-zinc-700/80 [&_td]:border-zinc-800/80",
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        disallowedElements={["img"]}
        components={{
          a: ({ className, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                "underline decoration-dotted underline-offset-2 transition-colors",
                isUser
                  ? "text-zinc-100 hover:text-white"
                  : "text-emerald-300 hover:text-emerald-200",
                className,
              )}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function remarkShortenUserFileMentions() {
  return (tree: unknown) => {
    visitMarkdownTextNodes(tree, (value) => shortenTextMentions(value));
  };
}

function visitMarkdownTextNodes(
  node: unknown,
  transform: (value: string) => string,
): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const candidate = node as {
    type?: unknown;
    value?: unknown;
    children?: unknown;
  };

  if (candidate.type === "text" && typeof candidate.value === "string") {
    candidate.value = transform(candidate.value);
  }

  if (!Array.isArray(candidate.children)) {
    return;
  }

  for (const child of candidate.children) {
    visitMarkdownTextNodes(child, transform);
  }
}

function shortenTextMentions(content: string): string {
  return content.replace(
    /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g,
    (
      fullMatch: string,
      prefix: string,
      quotedToken?: string,
      plainToken?: string,
    ) => {
      const rawToken = quotedToken ?? plainToken ?? "";
      const normalizedToken = unescapeMentionToken(rawToken.trim());
      if (!normalizedToken) {
        return fullMatch;
      }

      const basename = normalizedToken.split("/").pop() ?? normalizedToken;
      return `${prefix}@${basename}`;
    },
  );
}

function unescapeMentionToken(token: string): string {
  return token.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function parseThinkingTags(content: string): {
  visibleContent: string;
  thinkingBlocks: string[];
} {
  if (!content) {
    return { visibleContent: "", thinkingBlocks: [] };
  }

  const thinkingBlocks: string[] = [];
  const visibleContent = content.replace(
    /<(thinking|think)>([\s\S]*?)<\/\1>/gi,
    (_match: string, _tag: string, block: string) => {
      const trimmedBlock = block.trim();
      if (trimmedBlock) {
        thinkingBlocks.push(trimmedBlock);
      }
      return "";
    },
  );

  return {
    visibleContent: visibleContent.replace(/\n{3,}/g, "\n\n"),
    thinkingBlocks,
  };
}
