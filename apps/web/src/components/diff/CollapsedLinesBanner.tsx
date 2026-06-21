import { ChevronDown, ChevronUp } from "lucide-react";

export type CollapsedLinesPlacement = "start" | "middle" | "end";

export function CollapsedLinesBanner({
  count,
  split = false,
  onToggle,
  expanded = false,
  placement = "middle",
}: {
  count: number;
  split?: boolean;
  onToggle: () => void;
  expanded?: boolean;
  placement?: CollapsedLinesPlacement;
}) {
  const className = `mx-2 my-1 flex min-h-10 w-[calc(100%_-_1rem)] items-center rounded-md border border-zinc-800 bg-zinc-900/90 text-left font-mono text-xs text-zinc-400 ${
    split ? "col-span-2" : ""
  }`;
  const content = (
    <>
      <span className="flex w-10 shrink-0 flex-col items-center justify-center border-r border-zinc-800 text-zinc-300">
        {placement !== "end" ? <ChevronUp size={15} /> : null}
        {placement !== "start" ? <ChevronDown size={15} /> : null}
      </span>
      <span className="px-3 underline-offset-4 group-hover:underline">
        {count} unmodified line{count === 1 ? "" : "s"}
      </span>
    </>
  );

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`${className} group transition-colors hover:border-zinc-700 hover:bg-zinc-800`}
      aria-label={`${count} unmodified lines ${expanded ? "expanded" : "collapsed"}`}
      aria-expanded={expanded}
    >
      {content}
    </button>
  );
}
