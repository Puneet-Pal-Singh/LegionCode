import type { NativeDirectoryEntry } from "./NativeFilesystemBridge.js";

export const LOCAL_DIRECTORY_ENTRY_LIMIT = 200;
const MAX_OUTPUT_BYTES = 24_000;

/** Bounded, escaped first-page output; list_files has no cursor argument. */
export function formatLocalDirectory(input: {
  readonly path: string;
  readonly entries: readonly NativeDirectoryEntry[];
  readonly truncated: boolean;
  readonly reservedPathsOmitted?: boolean;
}) {
  if (
    Buffer.byteLength(input.path, "utf8") > 500 ||
    input.entries.length > LOCAL_DIRECTORY_ENTRY_LIMIT
  )
    throw new Error("Directory response exceeded its entry bound");
  const headerBudget =
    Buffer.byteLength(JSON.stringify(input.path), "utf8") + 300;
  const lines: string[] = [];
  let bytes = 0;
  for (const entry of input.entries) {
    if (
      !entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      /[/\\\0]/.test(entry.name) ||
      entry.path !==
        (input.path === "." ? entry.name : `${input.path}/${entry.name}`) ||
      Buffer.byteLength(entry.path, "utf8") > 500 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    )
      throw new Error("Directory returned an invalid entry");
    const line = JSON.stringify({
      path: entry.path,
      kind: entry.kind,
      bytes: entry.bytes,
      ...(entry.unavailableReason
        ? { unavailableReason: entry.unavailableReason }
        : {}),
    });
    const size = Buffer.byteLength(line, "utf8") + 1;
    // Reserve space for the bounded path/header and truthful truncation notice.
    if (bytes + size > MAX_OUTPUT_BYTES - headerBudget) break;
    lines.push(line);
    bytes += size;
  }
  const truncated = input.truncated || lines.length < input.entries.length;
  const header = `[list_files] path=${JSON.stringify(input.path)} returnedEntries=${lines.length} truncated=${truncated}`;
  return {
    output: [
      header,
      ...lines,
      ...(truncated
        ? [
            "Directory listing is truncated. Choose a narrower directory; list_files does not accept a cursor.",
          ]
        : []),
    ].join("\n"),
    truncated,
    metadata: {
      truncated,
      returnedEntries: lines.length,
      ...(input.reservedPathsOmitted ? { reservedPathsOmitted: true } : {}),
    },
  };
}
