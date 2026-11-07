import type { DiffContent, DiffHunk } from "@repo/shared-types";
import type { TurnDiffPayload } from "@repo/platform-protocol";

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
    isBinary: filePatch.lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch"),
    isNewFile: filePatch.lines.some((line) => /^new file mode [0-7]{6}$/u.test(line)),
    isDeleted: filePatch.lines.some((line) => /^deleted file mode [0-7]{6}$/u.test(line)),
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
    patches.find((candidate) => candidate.newPath === path)
    ?? patches.find((candidate) => candidate.oldPath === path)
    ?? null
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
  // Binary, rename-only and mode-only patches have no ---/+++ headers.
  const header = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/u.exec(lines[0] ?? "");
  const unchangedPaths = /^diff --git a\/(.*) b\/\1$/u.exec(lines[0] ?? "");
  const oldPath = readPathLine(lines, "--- ", "a/")
    ?? readPathLine(lines, "rename from ", "")
    ?? readPathLine(lines, "copy from ", "")
    ?? unchangedPaths?.[1]
    ?? (header?.[1] ? stripQuotedPath(header[1], "a/") : null);
  const newPath = readPathLine(lines, "+++ ", "b/")
    ?? readPathLine(lines, "rename to ", "")
    ?? readPathLine(lines, "copy to ", "")
    ?? unchangedPaths?.[1]
    ?? (header?.[2] ? stripQuotedPath(header[2], "b/") : null);
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
  prefix: string,
  gitPrefix: string,
): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line || line === `${prefix}/dev/null`) {
    return null;
  }
  return stripQuotedPath(line.slice(prefix.length), gitPrefix);
}

function stripQuotedPath(value: string, gitPrefix: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"')
    ? decodeQuotedGitPath(value.slice(1, -1))
    : value;
  return unquoted.startsWith(gitPrefix)
    ? unquoted.slice(gitPrefix.length)
    : unquoted;
}

// Git core.quotePath encodes UTF-8 bytes as octal, rather than JSON escapes.
function decodeQuotedGitPath(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = {
    a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r",
    '"': '"', "\\": "\\",
  };
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\") {
      const octal = /^[0-7]{1,3}/u.exec(value.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += octal[0].length + 1;
        continue;
      }
      const escaped = value[index + 1];
      if (escaped !== undefined && escapes[escaped] !== undefined) {
        bytes.push(...encoder.encode(escapes[escaped]));
        index += 2;
        continue;
      }
    }
    const character = String.fromCodePoint(value.codePointAt(index)!);
    bytes.push(...encoder.encode(character));
    index += character.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
