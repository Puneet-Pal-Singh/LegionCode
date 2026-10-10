const READ_HEADER_PATTERN =
  /^\[read_file\] path=(?<path>.+?) offset=(?<offset>\d+) limit=(?<limit>\d+) returnedLines=(?<returnedLines>\d+) totalLines=(?<totalLines>\d+) truncated=(?<truncated>true|false)(?: nextOffset=(?<nextOffset>\d+))?$/u;

export interface ReadFileOutput {
  content: string;
  offset: number;
  returnedLines: number;
  totalLines: number;
  truncated: boolean;
}

export function parseReadFileOutput(output: string): ReadFileOutput | null {
  const lines = output.split(/\r?\n/u);
  const match = READ_HEADER_PATTERN.exec(lines[0] ?? "");
  if (!match?.groups) {
    return null;
  }

  const offset = Number(match.groups.offset);
  const returnedLines = Number(match.groups.returnedLines);
  const body = lines
    .slice(1)
    .filter((line) => !line.startsWith("[read_file] Continue with "))
    .slice(0, returnedLines)
    .map((line, index) => stripRuntimeLineNumber(line, offset + index + 1));

  return {
    content: body.join("\n"),
    offset,
    returnedLines,
    totalLines: Number(match.groups.totalLines),
    truncated: match.groups.truncated === "true",
  };
}

export function normalizeReadFileContent(output: string): string {
  return parseReadFileOutput(output)?.content ?? output;
}

function stripRuntimeLineNumber(line: string, expectedLine: number): string {
  const prefix = `${expectedLine}:`;
  return line.startsWith(prefix)
    ? line.slice(prefix.length + (line[prefix.length] === " " ? 1 : 0))
    : line;
}
