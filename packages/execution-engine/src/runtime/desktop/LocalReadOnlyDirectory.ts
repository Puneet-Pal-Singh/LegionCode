import { lstat, opendir, type FileHandle } from "node:fs/promises";
import {
  isReservedNativeWorkspacePath,
  type NativeDirectoryEntry,
} from "./NativeFilesystemBridge.js";
import {
  formatLocalDirectory,
  LOCAL_DIRECTORY_ENTRY_LIMIT,
} from "./LocalDirectoryOutput.js";

// Node supports buffer-encoded directory names, but the installed Node typings
// omit that overload. Describe only the runtime methods consumed here; the
// Buffer check below still rejects any unexpected filename representation.
const openBufferDirectory = opendir as unknown as (
  path: string,
  options: { readonly encoding: "buffer"; readonly bufferSize: number },
) => Promise<{
  read(): Promise<{ readonly name: Buffer } | null>;
  close(): Promise<void>;
}>;

/** Incremental enumeration of an already-authorized held directory, never its pathname. */
export async function readLocalDirectory(input: {
  readonly path: string;
  readonly handle: FileHandle;
  readonly descriptorPath: string;
  readonly assertActive: () => void;
  readonly validateAfterOperation: () => Promise<void>;
}) {
  input.assertActive();
  const before = await input.handle.stat({ bigint: true });
  if (!before.isDirectory())
    throw new Error("Listing requires a workspace directory");
  const directory = await openBufferDirectory(input.descriptorPath, {
    encoding: "buffer",
    bufferSize: 16,
  });
  try {
    const entries: NativeDirectoryEntry[] = [];
    let scanned = 0;
    let truncated = false;
    let reservedPathsOmitted = false;
    for (;;) {
      input.assertActive();
      // Bound scans as well as returned entries, including reserved namespaces.
      if (scanned === 1_000) {
        truncated = true;
        break;
      }
      const child = await directory.read();
      input.assertActive();
      if (!child) break;
      scanned += 1;
      const rawName: unknown = child.name;
      if (!Buffer.isBuffer(rawName))
        throw new Error("Directory filename encoding is unavailable");
      const name = rawName.toString("utf8");
      if (
        !Buffer.from(name, "utf8").equals(rawName) ||
        !name ||
        /[/\\\0]/.test(name) ||
        name === "." ||
        name === ".."
      )
        throw new Error("Directory contains an unsupported filename");
      if (isReservedNativeWorkspacePath(name)) {
        reservedPathsOmitted = true;
        continue;
      }
      if (entries.length === LOCAL_DIRECTORY_ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      const path = input.path === "." ? name : `${input.path}/${name}`;
      if (Buffer.byteLength(path, "utf8") > 500)
        throw new Error("Directory entry exceeds the supported path bound");
      // lstat the held directory's child itself; symlinks are described, never followed.
      const stat = await lstat(`${input.descriptorPath}/${name}`);
      input.assertActive();
      if (!Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new Error("Directory entry exceeds the supported size bound");
      entries.push({
        name,
        path,
        bytes: stat.size,
        mode: stat.mode & 0o7777,
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : "other",
      });
    }
    const after = await input.handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error(
        "Directory changed during listing; request a fresh listing",
      );
    await input.validateAfterOperation();
    input.assertActive();
    return formatLocalDirectory({
      path: input.path,
      entries,
      truncated,
      reservedPathsOmitted,
    });
  } finally {
    await directory.close();
  }
}
