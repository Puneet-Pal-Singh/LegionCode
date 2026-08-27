import { cn } from "../../lib/utils";

interface DiffFileSummaryProps {
  additions: number;
  deletions: number;
  diffPath: string;
  isDeleted: boolean;
  isNewFile: boolean;
  layout?: "stacked" | "inline";
}

export function DiffFileSummary({
  additions,
  deletions,
  diffPath,
  isDeleted,
  isNewFile,
  layout = "stacked",
}: DiffFileSummaryProps) {
  const inline = layout === "inline";
  return (
    <div
      className={cn(
        "min-w-0",
        inline && "flex items-center justify-between gap-3",
      )}
    >
      <p className="truncate font-mono text-sm text-zinc-200">{diffPath}</p>
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-2 text-xs text-zinc-400",
          !inline && "mt-2",
        )}
      >
        {isNewFile ? (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
            New file
          </span>
        ) : null}
        {isDeleted ? (
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">
            Deleted file
          </span>
        ) : null}
        <span className="text-emerald-400">+{additions}</span>
        <span className="text-red-400">-{deletions}</span>
      </div>
    </div>
  );
}
