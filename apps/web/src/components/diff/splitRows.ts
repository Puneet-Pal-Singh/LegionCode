import type { DiffLine as DiffLineType } from "@repo/shared-types";
import type {
  CollapsedDiffRow,
  DiffRenderRow,
  VisibleDiffRow,
} from "./diffRenderPlan";

export interface SplitLineRow {
  kind: "line";
  key: string;
  rowKeys: string[];
  left: DiffLineType | null;
  right: DiffLineType | null;
}

export type SplitRenderRow = SplitLineRow | CollapsedDiffRow;

export function buildSplitRows(renderRows: DiffRenderRow[]): SplitRenderRow[] {
  const rows: SplitRenderRow[] = [];

  for (let index = 0; index < renderRows.length;) {
    const row = renderRows[index];
    if (!row) {
      return rows;
    }

    if (row.kind === "collapsed") {
      rows.push(row);
      index += 1;
      continue;
    }

    if (row.line.type === "unchanged") {
      rows.push({
        kind: "line",
        key: row.key,
        rowKeys: [row.key],
        left: row.line,
        right: row.line,
      });
      index += 1;
      continue;
    }

    const deleted: VisibleDiffRow[] = [];
    const added: VisibleDiffRow[] = [];
    while (index < renderRows.length) {
      const current = renderRows[index];
      if (
        !current ||
        current.kind === "collapsed" ||
        current.line.type === "unchanged"
      ) {
        break;
      }
      if (current.line.type === "deleted") {
        deleted.push(current);
      }
      if (current.line.type === "added") {
        added.push(current);
      }
      index += 1;
    }

    appendChangedSplitRows(rows, deleted, added, index);
  }

  return rows;
}

function appendChangedSplitRows(
  rows: SplitRenderRow[],
  deleted: VisibleDiffRow[],
  added: VisibleDiffRow[],
  index: number,
) {
  const chunkSize = Math.max(deleted.length, added.length);
  for (let rowIndex = 0; rowIndex < chunkSize; rowIndex += 1) {
    const leftEntry = deleted[rowIndex] ?? null;
    const rightEntry = added[rowIndex] ?? null;
    const rowKeys = [leftEntry, rightEntry]
      .filter((entry): entry is VisibleDiffRow => entry !== null)
      .map((entry) => entry.key);

    rows.push({
      kind: "line",
      key: rowKeys[0] ?? `split-empty-${index}-${rowIndex}`,
      rowKeys,
      left: leftEntry?.line ?? null,
      right: rightEntry?.line ?? null,
    });
  }
}
