import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceId } from "@repo/platform-protocol";
import {
  codingToolRegistry,
  MAX_TOOL_READ_LINES,
  MAX_TOOL_SEARCH_RESULTS,
} from "../tools/CodingToolRegistry.js";
import type { RuntimeExecutionService } from "../types.js";

export const LOCAL_READ_ONLY_TOOL_IDS = ["read_file", "list_files"] as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 2000;

/** Host-only filesystem backend. It has no shell, mutation, provider or lifecycle port. */
export class LocalReadOnlyExecutionService implements RuntimeExecutionService {
  constructor(
    private readonly options: {
      readonly resolveWorkspaceRoot: (
        workspaceId: WorkspaceId,
      ) => Promise<string>;
    },
  ) {}

  async execute(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    options?: Parameters<RuntimeExecutionService["execute"]>[3],
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    const definition = LOCAL_READ_ONLY_TOOL_IDS.map((id) =>
      codingToolRegistry.getDefinition(id),
    ).find(
      (tool) => tool?.route?.plugin === plugin && tool.route.action === action,
    );
    if (!definition || definition.sandboxClass !== "read") {
      throw new Error("Local read-only execution denies this tool route");
    }
    const scope = options?.scope;
    if (!scope)
      throw new Error("Local execution requires a canonical workspace scope");
    // Resolve the persisted grant on every operation, including after revocation.
    const granted = await this.options.resolveWorkspaceRoot(
      scope.workspaceId as WorkspaceId,
    );
    const root = await realpath(granted);
    if (root !== granted || resolve(scope.root) !== root) {
      throw new Error("Execution scope does not match the granted workspace");
    }
    const parsed = definition.inputSchema.parse(payload) as Record<
      string,
      unknown
    >;
    const path =
      typeof parsed.path === "string" && parsed.path ? parsed.path : ".";
    if (/[\r\n\0]/.test(path))
      throw new Error("Control characters are not allowed in workspace paths");
    const absolute = resolve(root, path);
    const local = relative(root, absolute);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error("Workspace path escapes the granted root");
    }
    // Do not follow symlinks, including aliases that point back inside the grant.
    let component = root;
    for (const part of local.split(sep).filter(Boolean)) {
      component = resolve(component, part);
      if ((await lstat(component)).isSymbolicLink()) {
        throw new Error(
          "Local read-only execution does not follow symbolic links",
        );
      }
    }
    if ((await realpath(absolute)) !== absolute)
      throw new Error("Workspace path changed during resolution");
    const initial = await lstat(absolute);
    const validateAfterOperation = async () => {
      options?.signal?.throwIfAborted();
      const currentRoot = await this.options.resolveWorkspaceRoot(
        scope.workspaceId as WorkspaceId,
      );
      const current = await lstat(absolute);
      if (
        currentRoot !== root ||
        (await realpath(absolute)) !== absolute ||
        current.isSymbolicLink() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino
      ) {
        throw new Error("Workspace grant or path changed during execution");
      }
    };
    options?.signal?.throwIfAborted();
    if (definition.id === "list_files") {
      if (!initial.isDirectory())
        throw new Error("Listing requires a workspace directory");
      const directory = await opendir(absolute);
      const names: string[] = [];
      let bytes = 0;
      let truncated = false;
      // Directory iteration closes its descriptor even when the bounded loop stops early.
      for await (const entry of directory) {
        options?.signal?.throwIfAborted();
        const name =
          entry.name.replace(/[\r\n]/g, (character) =>
            character === "\n" ? "\\n" : "\\r",
          ) + (entry.isDirectory() ? "/" : "");
        bytes += Buffer.byteLength(name) + 1;
        if (
          names.length === MAX_TOOL_SEARCH_RESULTS ||
          bytes > MAX_OUTPUT_BYTES
        ) {
          truncated = true;
          break;
        }
        names.push(name);
      }
      await validateAfterOperation();
      return { output: names.sort().join("\n"), metadata: { truncated } };
    }
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (stat.dev !== initial.dev || stat.ino !== initial.ino) {
        throw new Error("Workspace file changed during open");
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error("Read requires a regular text file of at most 4 MiB");
      }
      // Fixed buffer also bounds a file growing after stat; never read an unbounded file.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        options?.signal?.throwIfAborted();
        const read = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_FILE_BYTES)
        throw new Error("File exceeded the read limit");
      const text = buffer.subarray(0, length).toString("utf8");
      if (text.includes("\0"))
        throw new Error("Binary files are unavailable in text reads");
      const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
      const limit =
        typeof parsed.limit === "number" ? parsed.limit : MAX_TOOL_READ_LINES;
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
      const header = `[read_file] path=${path} offset=${offset} limit=${limit} returnedLines=${selected.length} totalLines=${lines.length} truncated=${truncated}${truncated ? ` nextOffset=${nextOffset}` : ""}`;
      await validateAfterOperation();
      return {
        output: [header, ...selected].join("\n"),
        metadata: { truncated, shortenedLine, nextOffset },
      };
    } finally {
      await handle.close();
    }
  }
}
