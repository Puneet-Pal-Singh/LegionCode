import { formatLocalReadFile } from "./LocalReadFileOutput.js";
import { readLocalDirectory } from "./LocalReadOnlyDirectory.js";
import { reservedComponent } from "./NativeFilesystemBridge.js";
import { openLocalWorkspaceEntry } from "./LocalReadOnlyWorkspaceHandle.js";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
import { codingToolRegistry } from "../tools/CodingToolRegistry.js";
import type { RuntimeExecutionService } from "../types.js";

export const LOCAL_READ_ONLY_TOOL_IDS = ["read_file", "list_files"] as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Host-only filesystem backend. It has no shell, mutation, provider or lifecycle port. */
export class LocalReadOnlyExecutionService implements RuntimeExecutionService {
  constructor(
    private readonly options: {
      readonly binding: LocalReadOnlyWorkspaceBinding;
    },
  ) {
    if (process.platform !== "linux") {
      throw new Error(
        "This platform requires the native descriptor-scoped read backend",
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
    if (local.split(sep).some(reservedComponent))
      throw new Error("Reserved workspace directories are unavailable");
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
    const entry = await openLocalWorkspaceEntry(
      root,
      local,
      definition.id === "list_files" ? "directory" : "file",
    );
    const handle = entry.handle;
    try {
      const stat = await handle.stat();
      if (stat.dev !== initial.dev || stat.ino !== initial.ino) {
        throw new Error("Workspace file changed during open");
      }
      if (definition.id === "list_files") {
        return await readLocalDirectory({
          path: local || ".",
          handle,
          descriptorPath: entry.descriptorPath,
          assertActive,
          validateAfterOperation,
        });
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
      await validateAfterOperation();
      return formatLocalReadFile({
        path,
        content: text,
        offset: typeof parsed.offset === "number" ? parsed.offset : undefined,
        limit: typeof parsed.limit === "number" ? parsed.limit : undefined,
      });
    } finally {
      await entry.close();
    }
  }
}
