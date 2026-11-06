import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { parse, sep } from "node:path";

/** Stable descriptor traversal: model paths never become symlink-following host paths. */
export async function openLocalWorkspaceEntry(
  root: string,
  relativePath: string,
  kind: "file" | "directory",
): Promise<{
  handle: FileHandle;
  descriptorPath: string;
  close(): Promise<void>;
}> {
  const descriptorPath = (fd: number) => {
    if (process.platform === "linux") return `/proc/self/fd/${fd}`;
    if (process.platform === "darwin") return `/dev/fd/${fd}`;
    throw new Error(
      "Descriptor-scoped local reads are unavailable on this platform",
    );
  };
  const handles: FileHandle[] = [];
  try {
    const filesystemRoot = parse(root).root;
    if (!filesystemRoot) throw new Error("Workspace root must be absolute");
    let handle = await open(
      filesystemRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(handle);
    // Anchor the grant itself too: an ancestor of the selected root may be renamed.
    for (const part of root
      .slice(filesystemRoot.length)
      .split(sep)
      .filter(Boolean)) {
      handle = await open(
        `${descriptorPath(handle.fd)}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
    }
    const parts = relativePath.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\0")
      ) {
        throw new Error("Invalid descriptor-relative workspace path");
      }
      const directory = index < parts.length - 1 || kind === "directory";
      handle = await open(
        `${descriptorPath(handle.fd)}/${part}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (directory ? constants.O_DIRECTORY : 0),
      );
      handles.push(handle);
    }
    if (!parts.length && kind === "file")
      throw new Error("Read requires a workspace file");
    return {
      handle,
      descriptorPath: descriptorPath(handle.fd),
      close: async () => {
        const results = await Promise.allSettled(
          handles.reverse().map((entry) => entry.close()),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    };
  } catch (error) {
    // Preserve the primary open/containment failure while closing every acquired descriptor.
    await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    throw error;
  }
}
