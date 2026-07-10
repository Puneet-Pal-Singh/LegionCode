import { useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import { cn } from "../../../lib/utils";
import { ChangeStats } from "./DiffStatistics";
import {
  calculateChangedFileTotals,
  getFileStats,
  splitPathForDisplay,
} from "./diff-statistics";
import { InlineDiffViewer } from "./InlineDiffViewer";
import { useChangedFileDiffStates } from "./useChangedFileDiffStates";
import type { ChangedFileDiffState } from "./types";

export function ChangedFilesCard({
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
  const togglePath = (path: string) =>
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-zinc-800/90 bg-zinc-950/65 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <div
        className={cn(
          "flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-2.5",
          !isExpanded && "border-b-0",
        )}
      >
        <div className="flex items-center gap-3 text-sm font-semibold text-zinc-100">
          <span>
            {files.length}{" "}
            {files.length === 1 ? "file changed" : "files changed"}
          </span>
          {files.length > 1 && <ChangeStats {...totals} />}
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
  const name = splitPathForDisplay(file.path);
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
          {name.directory}
          <span className="font-semibold text-zinc-100">{name.name}</span>
        </span>
        <ChangeStats {...getFileStats(file, diffState)} />
        <span className="text-zinc-600" aria-hidden="true">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && <ChangedFileInlineDiff diffState={diffState} />}
    </div>
  );
}

function ChangedFileInlineDiff({
  diffState,
}: {
  diffState?: ChangedFileDiffState;
}) {
  if (!diffState || diffState.loading)
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        Loading diff...
      </div>
    );
  if (diffState.error)
    return (
      <div className="border-t border-red-500/30 px-4 py-4 text-sm text-red-300">
        {diffState.error}
      </div>
    );
  if (!diffState.diff)
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        No diff available
      </div>
    );
  return <InlineDiffViewer diff={diffState.diff} />;
}
