import { Plus } from "lucide-react";
import type { DiffLine as DiffLineType } from "@repo/shared-types";
import { DiffCodeText } from "./DiffCodeText";

interface SplitDiffCellProps {
  line: DiffLineType | null;
  side: "left" | "right";
  language: string;
  wrap: boolean;
  isSelected: boolean;
  annotationCount: number;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAddComment?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function SplitDiffCell({
  line,
  side,
  language,
  wrap,
  isSelected,
  annotationCount,
  onClick,
  onAddComment,
}: SplitDiffCellProps) {
  if (!line) {
    return <EmptySplitCell isSelected={isSelected} onClick={onClick} />;
  }

  const lineNumber = side === "left" ? line.oldLineNumber : line.newLineNumber;

  return (
    <div
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`group relative flex min-h-8 min-w-full border-b border-l-2 border-zinc-900/80 font-mono text-sm ${
        isSelected ? "ring-1 ring-inset ring-sky-500/50" : ""
      } ${getSplitLineBackground(line.type)} ${getSplitLineBorder(line.type)}`}
    >
      <div className="absolute left-0 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        {onAddComment ? (
          <button
            type="button"
            onClick={onAddComment}
            className={`flex h-6 w-6 items-center justify-center rounded-md bg-sky-500 text-white shadow-[0_0_0_1px_rgba(125,211,252,0.35)] transition-opacity hover:bg-sky-400 ${
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            aria-label="Add comment"
          >
            <Plus size={14} />
          </button>
        ) : null}
      </div>
      <div className="w-12 shrink-0 px-2 py-1 text-right text-xs text-zinc-500">
        {lineNumber ?? ""}
      </div>
      <div className={`flex-1 px-3 py-1 ${getSplitLineText(line.type)}`}>
        <DiffCodeText content={line.content} language={language} wrap={wrap} />
      </div>
      {annotationCount > 0 ? (
        <div className="mr-3 flex items-center text-[10px] uppercase tracking-[0.16em] text-amber-300">
          {annotationCount}
        </div>
      ) : null}
    </div>
  );
}

function EmptySplitCell({
  isSelected,
  onClick,
}: {
  isSelected: boolean;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`min-h-8 border-b border-zinc-900/80 bg-black/60 ${
        isSelected ? "bg-sky-500/10" : ""
      }`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
    />
  );
}

function getSplitLineBackground(type: DiffLineType["type"]): string {
  if (type === "added") {
    return "bg-emerald-500/10";
  }

  return type === "deleted" ? "bg-rose-500/10" : "bg-black";
}

function getSplitLineText(type: DiffLineType["type"]): string {
  if (type === "added") {
    return "text-emerald-200";
  }

  return type === "deleted" ? "text-rose-200" : "text-zinc-300";
}

function getSplitLineBorder(type: DiffLineType["type"]): string {
  if (type === "added") {
    return "border-l-emerald-400";
  }

  return type === "deleted" ? "border-l-rose-400" : "border-l-transparent";
}
