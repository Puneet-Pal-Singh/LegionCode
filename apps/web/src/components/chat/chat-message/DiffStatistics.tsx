import type { ChangeLineStats } from "./types";

export function ChangeStats({ additions, deletions }: ChangeLineStats) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold">
      <span className="text-emerald-400">+{additions ?? "…"}</span>
      <span className="text-red-400">-{deletions ?? "…"}</span>
    </span>
  );
}
