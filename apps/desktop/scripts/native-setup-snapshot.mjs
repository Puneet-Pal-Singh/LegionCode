import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readlink, opendir, symlink, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** @typedef {{path: string, kind: "directory", mode: number} | {path: string, kind: "file", mode: number, size: number, sha256: string} | {path: string, kind: "symlink", target: string}} SnapshotEntry */
/** @typedef {{root: string, entries: SnapshotEntry[], identities: Map<string, string>, sha256: string}} BundleSnapshot */
const maximumBytes = 4 * 1024 ** 3;
const maximumEntries = 100_000;
const maximumPathBytes = 32 * 1024 ** 2;

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function unchanged(before, after) {
  if (identity(before) !== identity(after)) throw new Error("Application changed during snapshot capture");
}

// Resolve links using only captured names. Never realpath/open a link target.
/** @param {Map<string, SnapshotEntry>} entries */
function resolveLink(root, entries, path, target) {
  let parts = path.split(sep).slice(0, -1), remaining = target.split(sep), links = 0;
  const absolute = value => {
    if (!value.startsWith(`${root}${sep}`) && value !== root)
      throw new Error("Application link leaves its bundle");
    return value.slice(root.length).split(sep);
  };
  if (target.startsWith(sep)) { parts = []; remaining = absolute(target); }
  while (remaining.length) {
    const component = remaining.shift();
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!parts.length) throw new Error("Application link leaves its bundle");
      parts.pop(); continue;
    }
    const name = [...parts, component].join(sep), entry = entries.get(name);
    if (!entry) throw new Error("Application link target is missing");
    if (entry.kind === "symlink") {
      if (++links > 64) throw new Error("Application link exceeds its resolution bound");
      if (entry.target.startsWith(sep)) { parts = []; remaining = [...absolute(entry.target), ...remaining]; }
      else remaining = [...entry.target.split(sep), ...remaining];
    } else {
      if (remaining.length && entry.kind !== "directory") throw new Error("Application link traverses a non-directory");
      parts.push(component);
    }
  }
  return parts.join(sep);
}

/** Capture bounded typed contents, then recheck every source inode and timestamp.
 * atime is excluded because reading the snapshot may itself update it.
 * @returns {Promise<BundleSnapshot>}
 */
export async function captureBundleSnapshot(root, absoluteLinkRoot = root) {
  /** @type {SnapshotEntry[]} */
  const entries = [];
  /** @type {Map<string, string>} */
  const identities = new Map();
  let bytes = 0, pathBytes = 0;
  const deadline = performance.now() + 180_000;
  function bounded() {
    if (performance.now() > deadline) throw new Error("Application snapshot capture exceeded its deadline");
  }
  async function verifyAncestors(path) {
    let parent = path ? dirname(path) : ".";
    for (;;) {
      const name = parent === "." ? "" : parent;
      if (identities.get(name) !== identity(await lstat(name ? join(root, name) : root, { bigint: true })))
        throw new Error("Application ancestor changed during capture");
      if (!name) return;
      parent = dirname(name);
    }
  }
  async function visit(path, depth) {
    bounded();
    if (entries.length >= maximumEntries || depth > 64 || path.length > 4096 ||
        (pathBytes += Buffer.byteLength(path)) > maximumPathBytes)
      throw new Error("Application snapshot exceeds its traversal bound");
    const absolute = path ? join(root, path) : root;
    const before = await lstat(absolute, { bigint: true });
    identities.set(path, identity(before));
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (!path || !target || Buffer.byteLength(target) > 4096) throw new Error("Invalid application link");
      unchanged(before, await lstat(absolute, { bigint: true }));
      entries.push({ path, kind: "symlink", target }); return;
    }
    const mode = Number(before.mode & 0o777n);
    if (before.mode & 0o6000n) throw new Error("Application contains a setid inode");
    if (before.isDirectory()) {
      entries.push({ path, kind: "directory", mode });
      const names = [], directory = await opendir(absolute);
      for await (const entry of directory) {
        bounded();
        if (names.length + entries.length >= maximumEntries) throw new Error("Application directory exceeds its entry bound");
        names.push(entry.name);
      }
      unchanged(before, await lstat(absolute, { bigint: true }));
      await verifyAncestors(path);
      for (const name of names.sort()) await visit(path ? join(path, name) : name, depth + 1);
    } else if (before.isFile()) {
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || (bytes += size) > maximumBytes) throw new Error("Application snapshot exceeds its byte bound");
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        unchanged(before, await file.stat({ bigint: true }));
        await verifyAncestors(path);
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        let read = 0;
        for (;;) {
          bounded();
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - read + 1), null);
          if (!bytesRead) break;
          if ((read += bytesRead) > size) throw new Error("Application file grew during capture");
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (read !== size) throw new Error("Application file changed size during capture");
        unchanged(before, await file.stat({ bigint: true }));
        entries.push({ path, kind: "file", mode, size, sha256: hash.digest("hex") });
      } finally { await file.close(); }
    } else throw new Error("Application contains an unsupported inode");
    unchanged(before, await lstat(absolute, { bigint: true }));
  }
  await visit("", 0);
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    bounded();
    if (entry.kind === "symlink") resolveLink(absoluteLinkRoot, byPath, entry.path, entry.target);
    if (identities.get(entry.path) !== identity(await lstat(entry.path ? join(root, entry.path) : root, { bigint: true })))
      throw new Error("Application changed during snapshot capture");
  }
  // Absolute internal links are represented relative to the bundle for identity.
  const contents = entries.map(entry => entry.kind === "symlink"
    ? { ...entry, target: portableLinkTarget(absoluteLinkRoot, entry.path, entry.target) } : entry);
  return { root, entries, identities, sha256: createHash("sha256").update(JSON.stringify(contents)).digest("hex") };
}

function portableLinkTarget(root, path, target) {
  if (!target.startsWith(sep)) return target;
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Application link leaves its bundle");
  const parent = dirname(path), depth = parent === "." ? 0 : parent.split(sep).length;
  // Do not normalize away '..' through another symlink: preserve POSIX meaning.
  return "../".repeat(depth) + (target.slice(root.length + 1) || ".");
}

/** Rebase only captured absolute internal links in the owned copy, never source.
 * @param {BundleSnapshot} snapshot
 */
export async function relocateSnapshotLinks(snapshot, stagedRoot) {
  // Validate all copied inodes before any path-based staged mutation. The only
  // permitted relocation is an absolute link into the captured source bundle.
  const copied = await captureBundleSnapshot(stagedRoot, snapshot.root);
  if (copied.sha256 !== snapshot.sha256) throw new Error("Copied application does not match the captured source");
  for (const entry of snapshot.entries) {
    if (entry.kind !== "symlink" || !entry.target.startsWith(sep)) continue;
    const path = join(stagedRoot, entry.path), stat = await lstat(path);
    if (!stat.isSymbolicLink() || await readlink(path) !== entry.target) throw new Error("Staged application link changed during copy");
    await unlink(path);
    await symlink(portableLinkTarget(snapshot.root, entry.path, entry.target), path);
  }
}

/** Require both source identities and copied contents to match before sealing.
 * @param {BundleSnapshot} source
 */
export async function verifyBundleSnapshot(source, stagedRoot) {
  const staged = await captureBundleSnapshot(stagedRoot);
  const current = await captureBundleSnapshot(source.root);
  if (source.sha256 !== current.sha256 || source.identities.size !== current.identities.size ||
      [...source.identities].some(([path, value]) => current.identities.get(path) !== value))
    throw new Error("Source application changed while staging");
  if (source.sha256 !== staged.sha256) throw new Error("Staged application does not match the captured source");
  return staged;
}

/** Read-only tool invocations must not change the verified staged snapshot.
 * @param {BundleSnapshot} snapshot
 */
export async function verifySnapshotIdentities(snapshot) {
  for (const [path, expected] of snapshot.identities) {
    if (expected !== identity(await lstat(path ? join(snapshot.root, path) : snapshot.root, { bigint: true })))
      throw new Error("Verified application changed before sealing");
  }
}
