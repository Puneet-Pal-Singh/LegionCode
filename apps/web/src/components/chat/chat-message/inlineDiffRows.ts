import type { DiffContent, DiffLine } from "@repo/shared-types";
import type { InlineDiffRow } from "./types";

export function buildInlineDiffRows(
  diff: DiffContent,
  contextLineCount = 3,
): InlineDiffRow[] {
  return buildInlineDiffSegments(diff, contextLineCount)
    .sort(compareInlineDiffSegments)
    .flatMap((segment, index) => [
      ...(index === 0
        ? []
        : [{ kind: "separator" as const, key: `separator-${segment.key}` }]),
      ...segment.lines.map((line) => ({
        kind: "line" as const,
        key: line.key,
        line: line.line,
      })),
    ]);
}

function buildInlineDiffSegments(diff: DiffContent, contextLineCount: number) {
  const segments: Array<{
    key: string;
    lines: Array<{ key: string; line: DiffLine }>;
    sortLineNumber: number;
    originalIndex: number;
  }> = [];
  let originalIndex = 0;
  diff.hunks.forEach((hunk, hunkIndex) =>
    buildContextRanges(hunk.lines, contextLineCount).forEach(
      (range, rangeIndex) => {
        const lines = Array.from(
          { length: range.end - range.start + 1 },
          (_, offset) => {
            const lineIndex = range.start + offset;
            const line = hunk.lines[lineIndex];
            return line
              ? { key: `line-${hunkIndex}-${lineIndex}`, line }
              : null;
          },
        ).filter(
          (line): line is { key: string; line: DiffLine } => line !== null,
        );
        splitInlineDiffSegmentLines(lines).forEach((splitLines, splitIndex) => {
          segments.push({
            key: `${hunkIndex}-${rangeIndex}-${splitIndex}`,
            lines: splitLines,
            sortLineNumber: getSegmentSortLineNumber(splitLines),
            originalIndex,
          });
          originalIndex += 1;
        });
      },
    ),
  );
  return segments;
}

function splitInlineDiffSegmentLines(
  lines: Array<{ key: string; line: DiffLine }>,
) {
  const segments: Array<Array<{ key: string; line: DiffLine }>> = [];
  let current: Array<{ key: string; line: DiffLine }> = [];
  let previous: number | null = null;
  lines.forEach((line) => {
    const currentNumber = getInlineDiffSortLineNumber(line.line);
    if (
      current.length > 0 &&
      previous !== null &&
      currentNumber !== null &&
      currentNumber < previous
    ) {
      segments.push(current);
      current = [];
    }
    current.push(line);
    if (currentNumber !== null) previous = currentNumber;
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

function compareInlineDiffSegments(
  first: { sortLineNumber: number; originalIndex: number },
  second: { sortLineNumber: number; originalIndex: number },
) {
  return (
    first.sortLineNumber - second.sortLineNumber ||
    first.originalIndex - second.originalIndex
  );
}

function getSegmentSortLineNumber(lines: Array<{ line: DiffLine }>) {
  return lines.reduce((minimum, line) => {
    const number = getInlineDiffSortLineNumber(line.line);
    return number === null ? minimum : Math.min(minimum, number);
  }, Number.MAX_SAFE_INTEGER);
}

function getInlineDiffSortLineNumber(line: DiffLine): number | null {
  return line.type === "deleted"
    ? (line.oldLineNumber ?? null)
    : (line.newLineNumber ?? line.oldLineNumber ?? null);
}

function buildContextRanges(
  lines: DiffLine[],
  contextLineCount: number,
): Array<{ start: number; end: number }> {
  const changed = lines.flatMap((line, index) =>
    line.type === "unchanged" ? [] : [index],
  );
  return changed
    .map((index) => ({
      start: Math.max(0, index - contextLineCount),
      end: Math.min(lines.length - 1, index + contextLineCount),
    }))
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range.start > previous.end + 1)
        merged.push({ ...range });
      else previous.end = Math.max(previous.end, range.end);
      return merged;
    }, []);
}
