import type { DiffContent, DiffHunk } from "@repo/shared-types";
import type { TurnDiffPayload } from "../api/lifecycleClient";

const HUNK_HEADER_PATTERN =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@(?<header>.*)$/u;

export function buildDiffContentFromTurnDiff(
  turnDiff: TurnDiffPayload,
  path: string,
): DiffContent | null {
  const filePatch = findFilePatch(turnDiff.patch, path);
  if (!filePatch) {
    return null;
  }
  return {
    oldPath: filePatch.oldPath,
    newPath: filePatch.newPath,
    hunks: parseHunks(filePatch.lines),
    isBinary: filePatch.lines.some((line) => line.startsWith("Binary files ")),
    isNewFile: filePatch.lines.some((line) => line === "new file mode 100644"),
    isDeleted: filePatch.lines.some((line) => line === "deleted file mode 100644"),
  };
}

interface FilePatch {
  readonly oldPath: string;
  readonly newPath: string;
  readonly lines: readonly string[];
}

function findFilePatch(patch: string, path: string): FilePatch | null {
  const patches = splitFilePatches(patch);
  return (
    patches.find(
      (candidate) => candidate.oldPath === path || candidate.newPath === path,
    ) ?? null
  );
}

function splitFilePatches(patch: string): FilePatch[] {
  const lines = patch.split(/\r?\n/u);
  const patches: FilePatch[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushPatch(patches, current);
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  pushPatch(patches, current);
  return patches;
}

function pushPatch(patches: FilePatch[], lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  const paths = readPatchPaths(lines);
  if (!paths) {
    return;
  }
  patches.push({ ...paths, lines });
}

function readPatchPaths(
  lines: readonly string[],
): Pick<FilePatch, "oldPath" | "newPath"> | null {
  const oldPath = readPathLine(lines, "--- ", "a/");
  const newPath = readPathLine(lines, "+++ ", "b/");
  if (!oldPath && !newPath) {
    return null;
  }
  return {
    oldPath: oldPath ?? newPath ?? "",
    newPath: newPath ?? oldPath ?? "",
  };
}

function readPathLine(
  lines: readonly string[],
  prefix: "--- " | "+++ ",
  gitPrefix: "a/" | "b/",
): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line || line === `${prefix}/dev/null`) {
    return null;
  }
  return stripQuotedPath(line.slice(prefix.length), gitPrefix);
}

function stripQuotedPath(value: string, gitPrefix: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  return unquoted.startsWith(gitPrefix)
    ? unquoted.slice(gitPrefix.length)
    : unquoted;
}

function parseHunks(lines: readonly string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    const header = HUNK_HEADER_PATTERN.exec(line);
    if (header?.groups) {
      current = createHunk(header.groups);
      oldLineNumber = current.oldStart;
      newLineNumber = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\ No newline")) {
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({
        type: "added",
        content: line,
        newLineNumber: newLineNumber++,
      });
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({
        type: "deleted",
        content: line,
        oldLineNumber: oldLineNumber++,
      });
      continue;
    }
    current.lines.push({
      type: "unchanged",
      content: line,
      oldLineNumber: oldLineNumber++,
      newLineNumber: newLineNumber++,
    });
  }

  return hunks;
}

function createHunk(groups: Record<string, string | undefined>): DiffHunk {
  return {
    oldStart: Number(groups.oldStart),
    oldLines: Number(groups.oldLines ?? "1"),
    newStart: Number(groups.newStart),
    newLines: Number(groups.newLines ?? "1"),
    lines: [],
    header: `@@ -${groups.oldStart}${groups.oldLines ? `,${groups.oldLines}` : ""} +${groups.newStart}${groups.newLines ? `,${groups.newLines}` : ""} @@${groups.header ?? ""}`,
  };
}
