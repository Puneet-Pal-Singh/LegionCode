import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LOCAL_CHAT_MEDIA_LIMITS, LocalChatMediaError, mediaDigest, mediaScopeKey,
  verifyMediaRecord, type LocalChatMediaRecord, type LocalDecodedChatImage,
} from "./local-chat-media-records.js";
import type { LocalTurnMediaScope } from "./local-turn-media.js";

const MAX_MANIFEST_BYTES = 32 * 1024;
type Identity = { dev: bigint; ino: bigint };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => new LocalChatMediaError("unavailable", "Local image bytes could not be verified");

/** Private host blob namespace, outside every workspace grant. This does not
 * claim protection from another process controlling the invoking user's profile.
 * Admissions/lifecycle own product state; files contain only original bytes and
 * their immutable scope/integrity manifest.
 */
export class LocalChatMediaFiles {
  private rootIdentity?: Promise<Identity>;
  private readonly root: string;
  constructor(private readonly storageDirectory: string) {
    if (!isAbsolute(storageDirectory) || storageDirectory.includes("\0")) throw unavailable();
    this.root = join(storageDirectory, "chat-media");
  }

  async publish(record: LocalChatMediaRecord, images: readonly LocalDecodedChatImage[], signal?: AbortSignal): Promise<void> {
    await this.withRoot(async (parent) => {
      signal?.throwIfAborted();
      const target = join(this.root, mediaScopeKey(record.scope));
      const existing = await this.readRecordIfPresent(target, record.scope);
      if (existing) {
        if (!isDeepStrictEqual(existing, record)) throw new LocalChatMediaError("conflict", "Turn images already contain different immutable content");
        await this.verifyImages(target, existing);
        await parent.sync();
        await this.assertRoot(parent);
        signal?.throwIfAborted();
        return;
      }
      const stage = join(this.root, `.pending-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      const directory = await open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const identity = await directory.stat({ bigint: true });
      const created: string[] = [];
      let published = false;
      try {
        for (let index = 0; index < images.length; index += 1) {
          signal?.throwIfAborted();
          const image = images[index]!;
          const saved = record.images[index]!;
          if (image.bytes.byteLength !== saved.reference.byteSize || mediaDigest(image.bytes) !== saved.sha256) throw unavailable();
          const path = join(stage, `${saved.reference.attachmentId}.bin`);
          await writeImmutable(path, image.bytes, () => created.push(path));
        }
        const manifest = join(stage, "manifest.json");
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.byteLength > MAX_MANIFEST_BYTES) throw unavailable();
        await writeImmutable(manifest, bytes, () => created.push(manifest));
        await directory.sync();
        signal?.throwIfAborted();
        await this.assertRoot(parent);
        if (!same(await lstat(stage, { bigint: true }), identity)) throw unavailable();
        try {
          // Every published directory is nonempty. POSIX rename cannot replace
          // an existing immutable batch; concurrent identical writers verify it.
          await rename(stage, target);
          published = true;
        } catch (error) {
          if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
          const raced = await this.readRecordIfPresent(target, record.scope);
          if (!raced || !isDeepStrictEqual(raced, record)) throw new LocalChatMediaError("conflict", "Turn images already contain different immutable content");
          await this.verifyImages(target, raced);
        }
        await parent.sync();
        await this.assertRoot(parent);
        signal?.throwIfAborted();
      } finally {
        try { if (!published && same(await lstat(stage, { bigint: true }), identity)) {
          // Delete only this invocation's exact files. Unexpected evidence is
          // retained; no recursive cleanup of an unfamiliar directory.
          for (const path of created.reverse()) await unlink(path);
          await rmdir(stage);
          await parent.sync();
        } } finally { await directory.close(); }
      }
    });
  }

  async read(scope: LocalTurnMediaScope, attachmentId: string): Promise<{
    record: LocalChatMediaRecord; image: LocalChatMediaRecord["images"][number]; bytes: Uint8Array;
  }> {
    return this.withRoot(async (parent) => {
      const directory = join(this.root, mediaScopeKey(scope));
      const record = await this.readRecordIfPresent(directory, scope);
      const image = record?.images.find((candidate) => candidate.reference.attachmentId === attachmentId);
      if (!record || !image) throw unavailable();
      const bytes = await readBounded(join(directory, `${image.reference.attachmentId}.bin`), LOCAL_CHAT_MEDIA_LIMITS.maxImageBytes);
      if (bytes.byteLength !== image.reference.byteSize || mediaDigest(bytes) !== image.sha256) throw unavailable();
      await this.assertRoot(parent);
      return { record, image, bytes };
    });
  }

  private async verifyImages(directory: string, record: LocalChatMediaRecord): Promise<void> {
    for (const image of record.images) {
      const bytes = await readBounded(join(directory, `${image.reference.attachmentId}.bin`), LOCAL_CHAT_MEDIA_LIMITS.maxImageBytes);
      if (bytes.byteLength !== image.reference.byteSize || mediaDigest(bytes) !== image.sha256) throw unavailable();
    }
  }
  private async readRecordIfPresent(directory: string, scope: LocalTurnMediaScope): Promise<LocalChatMediaRecord | null> {
    let handle: FileHandle;
    try { handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw unavailable(); }
    try {
      requirePrivate(await handle.stat({ bigint: true }), true);
      const bytes = await readBounded(join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
      return verifyMediaRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), scope);
    } finally { await handle.close(); }
  }
  private async withRoot<T>(operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    this.rootIdentity ??= this.initialize();
    await this.rootIdentity;
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await this.assertRoot(handle); return await operation(handle); }
    finally { await handle.close(); }
  }
  private async initialize(): Promise<Identity> {
    const base = await lstat(this.storageDirectory, { bigint: true });
    if (!base.isDirectory() || base.isSymbolicLink() || (base.mode & 0o022n) !== 0n ||
      (typeof process.getuid === "function" && base.uid !== BigInt(process.getuid())) ||
      await realpath(this.storageDirectory) !== this.storageDirectory) throw unavailable();
    try {
      await mkdir(this.root, { mode: 0o700 });
      const parent = await open(this.storageDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const stats = await lstat(this.root, { bigint: true });
    requirePrivate(stats, true);
    return stats;
  }
  private async assertRoot(handle: FileHandle): Promise<void> {
    const expected = await this.rootIdentity!;
    const [held, path] = await Promise.all([handle.stat({ bigint: true }), lstat(this.root, { bigint: true })]);
    requirePrivate(held, true);
    if (path.isSymbolicLink() || !same(held, expected) || !same(path, expected)) throw unavailable();
  }
}

async function writeImmutable(path: string, bytes: Uint8Array, created: () => void): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  created();
  try { await file.writeFile(bytes); await file.chmod(0o400); await file.sync(); }
  finally { await file.close(); }
}
async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    requirePrivate(before, false);
    if (before.size < 1n || before.size > BigInt(limit)) throw unavailable();
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.byteLength) {
      const read = await file.read(bytes, position, bytes.byteLength - position, position);
      if (!read.bytesRead) throw unavailable();
      position += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw unavailable();
    return bytes;
  } finally { await file.close(); }
}
function requirePrivate(stats: BigIntStats, directory: boolean): void {
  if ((directory ? !stats.isDirectory() : !stats.isFile()) || (stats.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid()))) throw unavailable();
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
