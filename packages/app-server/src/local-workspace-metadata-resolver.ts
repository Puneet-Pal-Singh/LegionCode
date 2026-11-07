import {
  parseNativeGitMetadataIdentity,
  type NativeFilesystemBridge,
  type NativeFilesystemExecution,
  type NativeGitMetadataLayout,
} from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import { realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** One private host owner for Git metadata discovery and protected-path checks.
 * The native helper resolves Git records; ordinary file-tool guards are unchanged.
 * Pre/post identity checks implement the approved cooperative namespace contract,
 * not an atomic pin for stock Git's later pathname opens.
 */
export class LocalWorkspaceMetadataResolver {
  private readonly protectedHostRoots: readonly string[];

  constructor(
    private readonly options: {
      readonly protectedHostRoots: readonly string[];
      readonly createInspector?: (
        rootDirectory: FileHandle,
        observeExecution: (execution: NativeFilesystemExecution) => void,
      ) => Pick<NativeFilesystemBridge, "inspectGitMetadataLayout">;
    },
  ) {
    this.protectedHostRoots = Object.freeze([...options.protectedHostRoots]);
  }

  async inspect(input: {
    readonly rootDirectory: FileHandle;
    readonly signal: AbortSignal;
    readonly observeExecution: (execution: NativeFilesystemExecution) => void;
    readonly purpose?: "association" | "mutation";
  }): Promise<NativeGitMetadataLayout> {
    input.signal.throwIfAborted();
    const inspector = this.options.createInspector?.(
      input.rootDirectory,
      input.observeExecution,
    );
    if (!inspector)
      throw new Error(
        "Canonical native Git metadata inspection is unavailable",
      );
    const layout = await inspector.inspectGitMetadataLayout({
      signal: input.signal,
      purpose: input.purpose,
    });
    parseNativeGitMetadataIdentity(layout.identity);
    if (input.purpose === "mutation" && !layout.storage)
      throw new Error("Validated writable Git storage is unavailable");
    const storage = layout.storage;
    for (const path of [
      layout.gitDirectory,
      layout.commonDirectory,
      layout.backlinkPath,
      ...(storage
        ? [
            storage.objectsDirectory,
            storage.packDirectory,
            storage.infoDirectory,
            storage.refsDirectory,
            storage.commonLogsDirectory,
            storage.worktreeLogsDirectory,
            storage.repositoryInfoDirectory,
          ]
        : []),
    ]) {
      if (path !== null) await this.assertOutsideProtectedRoots(path);
    }
    input.signal.throwIfAborted();
    return layout;
  }

  async assertOutsideProtectedRoots(path: string): Promise<void> {
    if (!isAbsolute(path) || /[\0\r\n]/u.test(path))
      throw new Error("Workspace metadata path is invalid");
    for (const configuredRoot of this.protectedHostRoots) {
      if (!isAbsolute(configuredRoot) || configuredRoot.includes("\0"))
        throw new Error("Protected host root configuration is invalid");
      // Refresh trusted host locations on every inspection, including settlement.
      const protectedRoot = await realpath(configuredRoot);
      const contains = (parent: string, child: string) => {
        const path = relative(parent, child);
        return (
          path === "" ||
          (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
        );
      };
      if (contains(path, protectedRoot) || contains(protectedRoot, path))
        throw new Error(
          "Workspace overlaps protected host storage or application files",
        );
    }
  }
}
