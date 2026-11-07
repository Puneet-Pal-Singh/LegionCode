import { MAX_TOOL_READ_LINES } from "../tools/CodingToolRegistry.js";

const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 2000;

/** One canonical line-window formatter for both descriptor-backed read adapters. */
export function formatLocalReadFile(input: {
  readonly path: string;
  readonly content: string;
  readonly offset?: number;
  readonly limit?: number;
}) {
  if (input.content.includes("\0"))
    throw new Error("Binary files are unavailable in text reads");
  const lines =
    input.content === ""
      ? []
      : input.content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const offset = input.offset ?? 0;
  const limit = input.limit ?? MAX_TOOL_READ_LINES;
  const selected: string[] = [];
  let bytes = 0;
  let shortenedLine = false;
  for (const line of lines.slice(offset, offset + limit)) {
    const encoded = Buffer.from(line);
    const shortened = encoded.length > MAX_LINE_BYTES;
    const display = shortened
      ? encoded.subarray(0, MAX_LINE_BYTES).toString("utf8") +
        " [line truncated]"
      : line;
    const numbered = `${offset + selected.length + 1}: ${display}`;
    const size = Buffer.byteLength(numbered) + 1;
    if (bytes + size > MAX_OUTPUT_BYTES) break;
    bytes += size;
    shortenedLine ||= shortened;
    selected.push(numbered);
  }
  const nextOffset = offset + selected.length;
  const truncated = nextOffset < lines.length;
  const header = `[read_file] path=${input.path} offset=${offset} limit=${limit} returnedLines=${selected.length} totalLines=${lines.length} truncated=${truncated}${truncated ? ` nextOffset=${nextOffset}` : ""}`;
  return {
    output: [header, ...selected].join("\n"),
    metadata: { truncated, shortenedLine, nextOffset },
  };
}
