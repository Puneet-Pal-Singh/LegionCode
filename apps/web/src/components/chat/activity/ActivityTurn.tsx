import type {
  ActivityFeedRowViewModel,
  ActivityTurnViewModel,
} from "../../../services/activity/ActivityFeedViewModel.js";
import { ActivityRow } from "./ActivityRow.js";

interface ActivityTurnProps {
  turn: ActivityTurnViewModel;
  expanded: boolean;
  onToggleTurn: () => void;
  expandedRows: Record<string, boolean>;
  onToggleRow: (rowKey: string, expanded: boolean) => void;
  onUsePlanInBuild?: () => void;
}

export function ActivityTurn({
  turn,
  expanded,
  onToggleTurn,
  expandedRows,
  onToggleRow,
  onUsePlanInBuild,
}: ActivityTurnProps) {
  if (!turn.hasVisibleRows) {
    return null;
  }

  if (turn.isActiveTurn) {
    return (
      <section className="space-y-3 py-1">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-sm text-zinc-300">
              {turn.elapsedLabel}
            </span>
          </div>
          <div className="h-px w-full bg-zinc-800/80" />
        </div>
        <div className="space-y-1">
          {turn.rows.map((row) => (
            <ActivityRow
              key={row.key}
              row={row}
              expanded={expandedRows[row.key] ?? true}
              onToggle={(expanded) => onToggleRow(row.key, expanded)}
              onUsePlanInBuild={onUsePlanInBuild}
              displayMode="transcript"
            />
          ))}
        </div>
      </section>
    );
  }

  if (turn.rows.length === 0) {
    return (
      <section className="space-y-3 py-1">
        <div className="text-sm text-zinc-400">{turn.elapsedLabel}</div>
        <div className="h-px w-full bg-zinc-800/80" />
      </section>
    );
  }

  return (
    <section className="space-y-3 py-1">
      <button
        type="button"
        onClick={onToggleTurn}
        aria-expanded={expanded}
        className="w-full text-left text-sm text-zinc-400 transition hover:text-zinc-100"
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0">{turn.elapsedLabel}</span>
          <ChevronIcon expanded={expanded} />
        </div>
      </button>
      <div className="h-px w-full bg-zinc-800/80" />

      {expanded ? (
        <div className="space-y-1">
          {turn.rows.map((row) => (
            <ActivityRow
              key={row.key}
              row={row}
              expanded={expandedRows[row.key] ?? !isCollapsedByDefault(row)}
              onToggle={(effectiveExpanded) =>
                onToggleRow(row.key, effectiveExpanded)
              }
              onUsePlanInBuild={onUsePlanInBuild}
              displayMode="transcript"
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isCollapsedByDefault(row: ActivityFeedRowViewModel): boolean {
  if (row.kind === "tool" || row.kind === "group") {
    return row.defaultCollapsed;
  }
  return false;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
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
      className={
        expanded ? "rotate-90 transition-transform" : "transition-transform"
      }
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
