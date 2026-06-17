import type {
  DiffContent,
  DiffHunk,
  DiffLine as DiffLineType,
} from "@repo/shared-types";
import { buildLineKey } from "../../lib/diff/useAnchorIndex";
import type { ReviewCommentDraft } from "../git/reviewComments";

export interface VisibleDiffRow {
  kind: "line";
  key: string;
  line: DiffLineType;
  lineIndex: number;
}

export interface CollapsedDiffRow {
  kind: "collapsed";
  key: string;
  hiddenLineCount: number;
}

export type DiffRenderRow = VisibleDiffRow | CollapsedDiffRow;

export interface HunkRenderPlan {
  hunkIndex: number;
  rows: DiffRenderRow[];
  selectableRowKeys: string[];
}

const CONTEXT_LINE_COUNT = 3;

export function collectCommentedRowKeys(
  reviewComments: ReviewCommentDraft[],
): Set<string> {
  return new Set(
    reviewComments.flatMap((comment) =>
      comment.anchors.map((anchor) => anchor.rowKey),
    ),
  );
}

export function buildRenderPlans(
  diff: DiffContent,
  commentedRowKeys: Set<string>,
): HunkRenderPlan[] {
  return diff.hunks.map((hunk, hunkIndex) =>
    buildHunkRenderPlan(hunk, hunkIndex, commentedRowKeys),
  );
}

function buildHunkRenderPlan(
  hunk: DiffHunk,
  hunkIndex: number,
  commentedRowKeys: Set<string>,
): HunkRenderPlan {
  const ranges = buildVisibleRanges(hunk.lines, hunkIndex, commentedRowKeys);
  const rows = buildRenderRows(hunk.lines, hunkIndex, ranges);
  const selectableRowKeys = rows.flatMap((row) =>
    row.kind === "line" ? [row.key] : [],
  );
  return { hunkIndex, rows, selectableRowKeys };
}

function buildVisibleRanges(
  lines: DiffLineType[],
  hunkIndex: number,
  commentedRowKeys: Set<string>,
) {
  const visibleIndexes = lines.flatMap((line, lineIndex) => {
    const rowKey = buildLineKey(hunkIndex, lineIndex);
    return line.type !== "unchanged" || commentedRowKeys.has(rowKey)
      ? [lineIndex]
      : [];
  });
  const ranges = visibleIndexes.map((lineIndex) => ({
    start: Math.max(0, lineIndex - CONTEXT_LINE_COUNT),
    end: Math.min(lines.length - 1, lineIndex + CONTEXT_LINE_COUNT),
  }));

  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
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

function buildRenderRows(
  lines: DiffLineType[],
  hunkIndex: number,
  ranges: Array<{ start: number; end: number }>,
): DiffRenderRow[] {
  if (ranges.length === 0) {
    return [
      {
        kind: "collapsed",
        key: `${hunkIndex}:all-collapsed`,
        hiddenLineCount: lines.length,
      },
    ];
  }

  const rows: DiffRenderRow[] = [];
  let nextLineIndex = 0;
  ranges.forEach((range, rangeIndex) => {
    appendCollapsedRows(rows, hunkIndex, nextLineIndex, range.start, rangeIndex);
    appendVisibleRows(rows, lines, hunkIndex, range);
    nextLineIndex = range.end + 1;
  });
  appendCollapsedRows(rows, hunkIndex, nextLineIndex, lines.length, ranges.length);
  return rows;
}

function appendCollapsedRows(
  rows: DiffRenderRow[],
  hunkIndex: number,
  start: number,
  end: number,
  position: number,
) {
  const hiddenLineCount = end - start;
  if (hiddenLineCount <= 0) {
    return;
  }

  rows.push({
    kind: "collapsed",
    key: `${hunkIndex}:collapsed:${position}:${start}-${end}`,
    hiddenLineCount,
  });
}

function appendVisibleRows(
  rows: DiffRenderRow[],
  lines: DiffLineType[],
  hunkIndex: number,
  range: { start: number; end: number },
) {
  for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) {
      continue;
    }

    rows.push({
      kind: "line",
      key: buildLineKey(hunkIndex, lineIndex),
      line,
      lineIndex,
    });
  }
}
