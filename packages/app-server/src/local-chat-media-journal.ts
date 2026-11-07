import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hasCode, readBounded, requirePrivate, MAX_MANIFEST_BYTES } from "./local-chat-media-files.js";
import {
  LocalChatMediaRecordSchema, LocalChatMediaError, LOCAL_CHAT_MEDIA_LIMITS,
  mediaScopeKey, verifyMediaRecord, type LocalChatMediaRecord,
} from "./local-chat-media-records.js";

const PendingSchema = z.object({
  version: z.literal(1), phase: z.enum(["pending", "discarding"]), record: LocalChatMediaRecordSchema,
}).strict();
export type LocalChatMediaPendingRecord = z.infer<typeof PendingSchema>;
export const LOCAL_CHAT_MEDIA_PENDING_LIMITS = Object.freeze({
  maxBatches: 8,
  // Reserve for both a complete batch and its one deterministic staging copy.
  maxBytes: 4 * (2 * LOCAL_CHAT_MEDIA_LIMITS.maxTotalBytes + 2 * MAX_MANIFEST_BYTES),
});
const reservation = (record: LocalChatMediaRecord) =>
  2 * record.images.reduce((bytes, image) => bytes + image.reference.byteSize, 0) + 2 * MAX_MANIFEST_BYTES;
const unavailable = () => new LocalChatMediaError("unavailable", "Pending local image resources require reconciliation");

/** Resource reservations only, never admission, acceptance or lifecycle truth.
 * The canonical lookup decides disposition. Unknown evidence blocks new writes.
 */
export class LocalChatMediaJournal {
  private readonly root: string;
  private readonly directory: string;
  private identity?: Promise<{ dev: bigint; ino: bigint }>;
  constructor(storageDirectory: string) {
    this.root = join(storageDirectory, "chat-media");
    this.directory = join(this.root, ".pending-journal");
  }
  async scan(): Promise<{ records: LocalChatMediaPendingRecord[]; blocked: boolean }> {
    return this.withDirectory(async () => {
      const records: LocalChatMediaPendingRecord[] = [];
      let examined = 0, blocked = false;
      for await (const entry of await opendir(this.directory)) {
        examined += 1;
        if (examined > LOCAL_CHAT_MEDIA_PENDING_LIMITS.maxBatches) { blocked = true; break; }
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) { blocked = true; continue; }
        try {
          const pending = PendingSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true })
            .decode(await readBounded(join(this.directory, entry.name), MAX_MANIFEST_BYTES))));
          verifyMediaRecord(pending.record, pending.record.scope);
          if (entry.name !== `${mediaScopeKey(pending.record.scope)}.json`) throw unavailable();
          records.push(pending);
        } catch { blocked = true; }
      }
      return { records, blocked };
    });
  }
  async reserve(record: LocalChatMediaRecord): Promise<void> {
    const scanned = await this.scan();
    if (scanned.blocked) throw unavailable();
    const existing = scanned.records.find((entry) => mediaScopeKey(entry.record.scope) === mediaScopeKey(record.scope));
    if (existing) {
      if (existing.phase !== "pending" || !isDeepStrictEqual(existing.record, record)) {
        throw new LocalChatMediaError("conflict", "Pending Turn images have different immutable content");
      }
      return;
    }
    if (scanned.records.length >= LOCAL_CHAT_MEDIA_PENDING_LIMITS.maxBatches ||
      scanned.records.reduce((bytes, entry) => bytes + reservation(entry.record), reservation(record)) > LOCAL_CHAT_MEDIA_PENDING_LIMITS.maxBytes) {
      throw new LocalChatMediaError("unavailable", "Pending local images reached their storage quota");
    }
    await this.write({ version: 1, phase: "pending", record });
  }
  async markDiscarding(pending: LocalChatMediaPendingRecord): Promise<void> {
    if (pending.phase === "discarding") return;
    await this.write({ ...pending, phase: "discarding" });
  }
  async remove(pending: LocalChatMediaPendingRecord): Promise<void> {
    await this.withDirectory(async (directory) => {
      const path = join(this.directory, `${mediaScopeKey(pending.record.scope)}.json`);
      const current = PendingSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(await readBounded(path, MAX_MANIFEST_BYTES))));
      if (!isDeepStrictEqual(current.record, pending.record)) throw unavailable();
      await unlink(path);
      await directory.sync();
    });
  }
  private async write(pending: LocalChatMediaPendingRecord): Promise<void> {
    await this.withDirectory(async (directory) => {
      const bytes = Buffer.from(JSON.stringify(PendingSchema.parse(pending)));
      if (bytes.byteLength > MAX_MANIFEST_BYTES) throw unavailable();
      const temporary = join(this.directory, `.tmp-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let identity: { dev: bigint; ino: bigint } | undefined;
      let published = false;
      try {
        identity = await file.stat({ bigint: true });
        await file.writeFile(bytes); await file.chmod(0o400); await file.sync();
        await rename(temporary, join(this.directory, `${mediaScopeKey(pending.record.scope)}.json`));
        published = true;
        await directory.sync();
      } finally {
        await file.close();
        if (!published) {
          const current = await lstat(temporary, { bigint: true }).catch(() => null);
          if (identity && current && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
            await unlink(temporary); await directory.sync();
          }
        }
      }
    });
  }
  private async withDirectory<T>(operation: (directory: FileHandle) => Promise<T>): Promise<T> {
    this.identity ??= this.initialize();
    const expected = await this.identity;
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = await directory.stat({ bigint: true }); requirePrivate(stats, true);
      const path = await lstat(this.directory, { bigint: true });
      if (path.isSymbolicLink() || stats.dev !== expected.dev || stats.ino !== expected.ino || path.dev !== expected.dev || path.ino !== expected.ino) throw unavailable();
      return await operation(directory);
    } finally { await directory.close(); }
  }
  private async initialize() {
    requirePrivate(await lstat(this.root, { bigint: true }), true);
    try {
      await mkdir(this.directory, { mode: 0o700 });
      const parent = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const stats = await lstat(this.directory, { bigint: true }); requirePrivate(stats, true);
    return stats;
  }
}
