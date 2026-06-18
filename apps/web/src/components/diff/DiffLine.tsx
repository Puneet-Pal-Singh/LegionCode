import { memo } from "react";
import { Plus } from "lucide-react";
import type { DiffLine as DiffLineType } from "@repo/shared-types";
import { DiffCodeText } from "./DiffCodeText";

interface DiffLineProps {
  line: DiffLineType;
  hunksIndex: number;
  lineIndex: number;
  language?: string;
  wrap?: boolean;
  isSelected?: boolean;
  annotationCount?: number;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAddComment?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const DiffLine = memo(
  ({
    line,
    hunksIndex,
    lineIndex,
    language = "text",
    wrap = false,
    isSelected = false,
    annotationCount = 0,
    onClick,
    onAddComment,
  }: DiffLineProps) => {
    const bgColor =
      line.type === "added"
        ? "bg-emerald-500/10"
        : line.type === "deleted"
          ? "bg-rose-500/10"
          : "bg-black";

    const borderColor =
      line.type === "added"
        ? "border-l-emerald-400"
        : line.type === "deleted"
          ? "border-l-rose-400"
          : "border-l-transparent";

    const textColor =
      line.type === "added"
        ? "text-emerald-200"
        : line.type === "deleted"
          ? "text-rose-200"
          : "text-zinc-300";

    return (
      <div
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-pressed={onClick ? isSelected : undefined}
        className={`group relative flex min-w-full border-l-2 text-left font-mono text-sm transition-colors ${
          wrap ? "w-full" : "w-max"
        } ${
          isSelected ? "bg-sky-500/10" : ""
        } ${borderColor} ${bgColor}`}
        key={`${hunksIndex}-${lineIndex}`}
      >
        {onAddComment ? (
          <span className="absolute left-[4.35rem] top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <span
              className={`block rounded-md transition-opacity ${
                isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <span className="block rounded-md bg-sky-500 shadow-[0_0_0_1px_rgba(125,211,252,0.35)]">
                <span className="block">
                  <button
                    type="button"
                    onClick={onAddComment}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-white transition-colors hover:bg-sky-400"
                    aria-label="Add comment"
                  >
                    <Plus size={14} />
                  </button>
                </span>
              </span>
            </span>
          </span>
        ) : null}
        <div className="w-12 flex-shrink-0 px-2 py-1 text-right text-xs text-zinc-500">
          {line.oldLineNumber && <span>{line.oldLineNumber}</span>}
        </div>
        <div className="w-12 flex-shrink-0 px-2 py-1 text-right text-xs text-zinc-500">
          {line.newLineNumber && <span>{line.newLineNumber}</span>}
        </div>
        <div className={`flex-1 px-3 py-1 ${textColor}`}>
          <DiffCodeText content={line.content} language={language} wrap={wrap} />
        </div>
        {annotationCount > 0 ? (
          <div className="mr-3 flex items-center text-[10px] uppercase tracking-[0.16em] text-amber-300">
            {annotationCount} note{annotationCount === 1 ? "" : "s"}
          </div>
        ) : null}
      </div>
    );
  },
);

DiffLine.displayName = "DiffLine";

export default DiffLine;
