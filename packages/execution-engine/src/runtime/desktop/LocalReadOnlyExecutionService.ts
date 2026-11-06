import { openLocalWorkspaceEntry } from "./LocalReadOnlyWorkspaceHandle.js";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
import {
  codingToolRegistry,
  MAX_TOOL_READ_LINES,
} from "../tools/CodingToolRegistry.js";
import type { RuntimeExecutionService } from "../types.js";

export const LOCAL_READ_ONLY_TOOL_IDS = ["read_file"] as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 2000;

/** Host-only filesystem backend. It has no shell, mutation, provider or lifecycle port. */
export class LocalReadOnlyExecutionService implements RuntimeExecutionService {
  constructor(
    private readonly options: {
      readonly binding: LocalReadOnlyWorkspaceBinding;
    },
  ) {
    if (process.platform !== "linux") {
      throw new Error(
        "This platform requires the native descriptor-scoped read_file backend",
      );
    }
  }

  async execute(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    options?: Parameters<RuntimeExecutionService["execute"]>[3],
  ): Promise<unknown> {
    try {
      return await this.executeRead(plugin, action, payload, options);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "ENOENT")
          throw new Error("Requested workspace file was not found");
        if (code === "ELOOP")
          throw new Error("Workspace symbolic links are unavailable");
        if (typeof code === "string" && code.startsWith("E")) {
          throw new Error("Workspace read could not be completed safely");
        }
      }
      throw error;
    }
  }

  private async executeRead(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    options?: Parameters<RuntimeExecutionService["execute"]>[3],
  ): Promise<unknown> {
    const binding = this.options.binding;
    const assertActive = () => {
      options?.signal?.throwIfAborted();
      binding.signal.throwIfAborted();
    };
    assertActive();
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
    await binding.assertCurrent();
    assertActive();
    const granted = binding.filesystemRoot;
    const root = await realpath(granted);
    if (
      binding.workspace.workspaceId !== scope.workspaceId ||
      root !== granted ||
      resolve(scope.root) !== root
    ) {
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
      assertActive();
      await binding.assertCurrent();
      assertActive();
      const currentRoot = binding.filesystemRoot;
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
    assertActive();
    const entry = await openLocalWorkspaceEntry(root, local, "file");
    const handle = entry.handle;
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
        assertActive();
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
      await entry.close();
    }
  }
}
