import type { DiffContent, DiffLine } from "@repo/shared-types";
import { cn } from "../../../lib/utils";
import { buildInlineDiffRows } from "./inlineDiffRows";

export function InlineDiffViewer({ diff }: { diff: DiffContent }) {
  if (diff.isBinary)
    return (
      <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
        Binary file changed
      </div>
    );
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
  const style = getInlineDiffLineStyle(line.type);
  const lineNumber = getInlineDiffLineNumber(line);
  return (
    <div
      className={cn(
        "flex min-w-0 border-l-2 font-mono text-xs",
        style.container,
      )}
    >
      <span
        className={cn(
          "w-14 shrink-0 bg-zinc-900/60 px-2 py-1 text-right",
          style.number,
        )}
      >
        {lineNumber}
      </span>
      <pre
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words px-3 py-1",
          style.text,
        )}
      >
        {line.content}
      </pre>
    </div>
  );
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

function getInlineDiffLineNumber(line: DiffLine): string {
  const number = getInlineDiffSortLineNumber(line);
  return number === null ? "" : String(number);
}
function getInlineDiffSortLineNumber(line: DiffLine): number | null {
  return line.type === "deleted"
    ? (line.oldLineNumber ?? null)
    : (line.newLineNumber ?? line.oldLineNumber ?? null);
}
function getInlineDiffLineStyle(lineType: DiffLine["type"]) {
  if (lineType === "added")
    return {
      container: "border-l-emerald-400 bg-emerald-500/14",
      number: "text-emerald-400",
      text: "text-emerald-200",
    };
  if (lineType === "deleted")
    return {
      container: "border-l-red-400 bg-red-500/14",
      number: "text-red-400",
      text: "text-red-200",
    };
  return {
    container: "border-l-transparent bg-black",
    number: "text-zinc-500",
    text: "text-zinc-300",
  };
}
