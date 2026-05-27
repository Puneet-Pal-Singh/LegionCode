import type {
  DiffContent,
  DiffHunk,
  EditArtifactReviewFile,
  FileStatusType,
} from "@repo/shared-types";

export class EditArtifactPatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditArtifactPatchParseError";
  }
}

interface PatchFileBlock {
  headerPath: string;
  oldPath: string;
  newPath: string;
  lines: string[];
  status: FileStatusType;
  isBinary: boolean;
  isNewFile: boolean;
  isDeleted: boolean;
}

interface DiffLineCursorResult {
  line: DiffHunk["lines"][number];
  nextOldLineNumber: number;
  nextNewLineNumber: number;
}

export function parsePatchFileInventory(
  patch: string,
): EditArtifactReviewFile[] {
  return parsePatchFileBlocks(patch).map((block) => {
    const stats = countChangedLines(block.lines);
    return {
      path: selectReviewPath(block),
      status: block.status,
      additions: stats.additions,
      deletions: stats.deletions,
      diffAvailable: !block.isBinary && block.lines.some(isHunkHeader),
      artifactPath: selectReviewPath(block),
    };
  });
}

export function parsePatchFileDiff(input: {
  patch: string;
  path: string;
}): DiffContent {
  const block = findPatchFileBlock(parsePatchFileBlocks(input.patch), input.path);
  if (!block) {
    throw new EditArtifactPatchParseError(
      `No saved patch block found for ${input.path}`,
    );
  }

  if (block.isBinary) {
    return {
      oldPath: block.oldPath,
      newPath: block.newPath,
      hunks: [],
      isBinary: true,
      isNewFile: block.isNewFile,
      isDeleted: block.isDeleted,
    };
  }

  return {
    oldPath: block.oldPath,
    newPath: block.newPath,
    hunks: parseHunks(block.lines),
    isBinary: false,
    isNewFile: block.isNewFile,
    isDeleted: block.isDeleted,
  };
}

function parsePatchFileBlocks(patch: string): PatchFileBlock[] {
  const normalizedPatch = patch.trimEnd();
  if (!normalizedPatch) {
    throw new EditArtifactPatchParseError("Saved artifact patch is empty");
  }

  const blocks: PatchFileBlock[] = [];
  let currentLines: string[] = [];
  for (const line of normalizedPatch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      pushBlock(blocks, currentLines);
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  pushBlock(blocks, currentLines);

  if (blocks.length === 0) {
    throw new EditArtifactPatchParseError("Saved artifact patch has no files");
  }

  return blocks;
}

function pushBlock(blocks: PatchFileBlock[], lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  const headerPath = parseDiffHeaderPath(lines[0] ?? "");
  if (!headerPath) {
    return;
  }

  const oldPath = parsePathHeader(lines, "--- ") ?? headerPath;
  const newPath = parsePathHeader(lines, "+++ ") ?? headerPath;
  const isNewFile = lines.some((line) => line.startsWith("new file mode ")) ||
    oldPath === "/dev/null";
  const isDeleted = lines.some((line) => line.startsWith("deleted file mode ")) ||
    newPath === "/dev/null";
  const isBinary = lines.some((line) => line.startsWith("Binary files "));
  blocks.push({
    headerPath,
    oldPath,
    newPath,
    lines,
    status: readStatus(lines, isNewFile, isDeleted),
    isBinary,
    isNewFile,
    isDeleted,
  });
}

function parseDiffHeaderPath(line: string): string | null {
  const match = line.match(/^diff --git (.+) (.+)$/);
  if (!match?.[2]) {
    return null;
  }
  return normalizePatchPath(match[2]);
}

function parsePathHeader(lines: string[], prefix: "--- " | "+++ "): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return null;
  }
  return normalizePatchPath(line.slice(prefix.length));
}

function normalizePatchPath(path: string): string {
  const unquoted = stripGitQuotes(path.trim());
  if (unquoted === "/dev/null") {
    return unquoted;
  }
  return unquoted.replace(/^[ab]\//, "");
}

function stripGitQuotes(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
}

function readStatus(
  lines: string[],
  isNewFile: boolean,
  isDeleted: boolean,
): FileStatusType {
  if (isNewFile) {
    return "added";
  }
  if (isDeleted) {
    return "deleted";
  }
  if (lines.some((line) => line.startsWith("rename from "))) {
    return "renamed";
  }
  return "modified";
}

function selectReviewPath(block: PatchFileBlock): string {
  if (block.newPath !== "/dev/null") {
    return block.newPath;
  }
  if (block.oldPath !== "/dev/null") {
    return block.oldPath;
  }
  return block.headerPath;
}

function countChangedLines(lines: string[]): {
  additions: number;
  deletions: number;
} {
  return lines.reduce(
    (counts, line) => {
      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        return { ...counts, additions: counts.additions + 1 };
      }
      if (line.startsWith("-") && !line.startsWith("--- ")) {
        return { ...counts, deletions: counts.deletions + 1 };
      }
      return counts;
    },
    { additions: 0, deletions: 0 },
  );
}

function findPatchFileBlock(
  blocks: PatchFileBlock[],
  path: string,
): PatchFileBlock | null {
  return (
    blocks.find((block) =>
      [block.headerPath, block.oldPath, block.newPath].includes(path),
    ) ?? null
  );
}

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLineCursor = 0;
  let newLineCursor = 0;

  for (const line of lines) {
    if (isHunkHeader(line)) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      const parsedHeader = parseHunkHeader(line);
      oldLineCursor = parsedHeader.oldStart;
      newLineCursor = parsedHeader.newStart;
      currentHunk = { ...parsedHeader, lines: [], header: line };
      continue;
    }

    if (currentHunk && isDiffBodyLine(line)) {
      const nextLine = createDiffLine(line, oldLineCursor, newLineCursor);
      oldLineCursor = nextLine.nextOldLineNumber;
      newLineCursor = nextLine.nextNewLineNumber;
      currentHunk.lines.push(nextLine.line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

function isHunkHeader(line: string): boolean {
  return line.startsWith("@@");
}

function parseHunkHeader(
  line: string,
): Omit<DiffHunk, "lines" | "header"> {
  const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match?.[1] || !match[3]) {
    throw new EditArtifactPatchParseError(`Invalid patch hunk header: ${line}`);
  }

  return {
    oldStart: Number.parseInt(match[1], 10),
    oldLines: Number.parseInt(match[2] ?? "1", 10),
    newStart: Number.parseInt(match[3], 10),
    newLines: Number.parseInt(match[4] ?? "1", 10),
  };
}

function isDiffBodyLine(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("+") || line.startsWith("-");
}

function createDiffLine(
  line: string,
  oldLineNumber: number,
  newLineNumber: number,
): DiffLineCursorResult {
  if (line.startsWith("+")) {
    return {
      line: { type: "added", content: line.slice(1), newLineNumber },
      nextOldLineNumber: oldLineNumber,
      nextNewLineNumber: newLineNumber + 1,
    };
  }

  if (line.startsWith("-")) {
    return {
      line: { type: "deleted", content: line.slice(1), oldLineNumber },
      nextOldLineNumber: oldLineNumber + 1,
      nextNewLineNumber: newLineNumber,
    };
  }

  return {
    line: {
      type: "unchanged",
      content: line.slice(1),
      oldLineNumber,
      newLineNumber,
    },
    nextOldLineNumber: oldLineNumber + 1,
    nextNewLineNumber: newLineNumber + 1,
  };
}
