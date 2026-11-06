import { constants } from "node:fs";
import {
  open,
  realpath,
  rename,
  stat,
  lstat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HarnessHostError } from "./errors.js";

export interface ObservationJournalCodec<T> {
  /** Use the canonical worker-protocol schema, including the exact stream binding. */
  parse(value: unknown): T;
  sequence(frame: T): number;
}

export interface ObservationJournalOptions<T> {
  readonly directory: string;
  readonly streamKey: string;
  readonly codec: ObservationJournalCodec<T>;
  readonly maxBytes: number;
  readonly maxFrames: number;
}

interface JournalState<T> {
  readonly version: 1;
  readonly streamKey: string;
  readonly nextSequence: number;
  readonly frames: readonly T[];
}

/** Only unacknowledged observations. Never a transcript, command log or lifecycle authority. */
export class ObservationDeliveryJournal<T> {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private queuedOperations = 0;
  private closed = false;
  private closing?: Promise<void>;

  private constructor(
    private readonly path: string,
    private readonly directory: string,
    private readonly codec: ObservationJournalCodec<T>,
    private readonly limits: {
      readonly maxBytes: number;
      readonly maxFrames: number;
    },
    private state: JournalState<T>,
    private readonly writer: FileHandle,
  ) {}

  static async open<T>(
    input: ObservationJournalOptions<T>,
  ): Promise<ObservationDeliveryJournal<T>> {
    const { path, directory } = await journalLocation(input);
    let writer: FileHandle;
    try {
      // Persistent exclusive creation also excludes another Node process. Never steal a stale lock.
      writer = await open(`${path}.writer`, "wx", 0o600);
    } catch {
      throw new HarnessHostError("journal_busy");
    }
    try {
      await writer.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await writer.sync();
      const state = await readState(path, input);
      return new ObservationDeliveryJournal(
        path,
        directory,
        input.codec,
        input,
        state,
        writer,
      );
    } catch {
      await writer.close();
      await unlink(`${path}.writer`);
      throw new HarnessHostError("journal_corrupt");
    }
  }

  /** Read-only crash/recovery evidence. Never removes a lock, allocates a sequence or enables work.
   * The canonical owner fences the old generation, commits/deduplicates these frames, then starts
   * a new UUID generation. A dead process's journal is never reopened as a new writer. */
  static async readPending<T>(
    input: ObservationJournalOptions<T>,
  ): Promise<readonly T[]> {
    const { path } = await journalLocation(input);
    return (await readState(path, input)).frames;
  }

  /** Drain accepted writes before releasing this exact writer's ownership. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.queue;
      try {
        const [held, current] = await Promise.all([
          this.writer.stat(),
          lstat(`${this.path}.writer`),
        ]);
        if (held.dev !== current.dev || held.ino !== current.ino)
          throw new HarnessHostError("journal_corrupt");
        await unlink(`${this.path}.writer`);
      } catch {
        this.failed = true;
        throw new HarnessHostError("journal_corrupt");
      } finally {
        await this.writer.close();
      }
    })();
    return this.closing;
  }

  /** Allocate and persist the sequence before the frame can be sent. */
  append(create: (sequence: number) => T): Promise<T> {
    return this.serialize(async () => {
      const sequence = this.state.nextSequence;
      if (!Number.isSafeInteger(sequence + 1))
        throw new HarnessHostError("journal_overflow");
      // Snapshot the frame so a caller cannot mutate durable delivery after validation.
      const frame = this.codec.parse(
        JSON.parse(JSON.stringify(create(sequence))),
      );
      if (this.codec.sequence(frame) !== sequence)
        throw new HarnessHostError("journal_corrupt");
      const next = {
        ...this.state,
        nextSequence: sequence + 1,
        frames: [...this.state.frames, frame],
      };
      if (next.frames.length > this.limits.maxFrames)
        throw new HarnessHostError("journal_overflow");
      await this.persist(next);
      this.state = next;
      return this.codec.parse(JSON.parse(JSON.stringify(frame)));
    });
  }

  /** Caller validates a canonical commit ACK's full stream identity before calling. ACKs are exact, not cumulative. */
  acknowledge(sequence: number): Promise<void> {
    return this.serialize(async () => {
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence >= this.state.nextSequence
      ) {
        throw new HarnessHostError("journal_corrupt");
      }
      const frames = this.state.frames.filter(
        (frame) => this.codec.sequence(frame) !== sequence,
      );
      if (frames.length === this.state.frames.length) return;
      const next = { ...this.state, frames };
      await this.persist(next);
      this.state = next;
    });
  }

  pending(): Promise<readonly T[]> {
    return this.serialize(async () =>
      this.state.frames.map((frame) =>
        this.codec.parse(JSON.parse(JSON.stringify(frame))),
      ),
    );
  }

  private serialize<R>(action: () => Promise<R>): Promise<R> {
    if (this.closed)
      return Promise.reject(new HarnessHostError("journal_busy"));
    // Provider callbacks can outpace disk. Bound closures/promises as well as persisted frames.
    if (this.queuedOperations >= 32)
      return Promise.reject(new HarnessHostError("journal_overflow"));
    this.queuedOperations++;
    const result = this.queue
      .then(() => {
        if (this.failed) throw new HarnessHostError("journal_corrupt");
        return this.assertWriter().then(action);
      })
      .finally(() => {
        this.queuedOperations--;
      });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async assertWriter(): Promise<void> {
    try {
      const [held, current] = await Promise.all([
        this.writer.stat(),
        lstat(`${this.path}.writer`),
      ]);
      if (held.dev !== current.dev || held.ino !== current.ino)
        throw new HarnessHostError("journal_busy");
    } catch {
      this.failed = true;
      throw new HarnessHostError("journal_busy");
    }
  }

  private async persist(next: JournalState<T>): Promise<void> {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > this.limits.maxBytes)
      throw new HarnessHostError("journal_overflow");
    const temporary = `${this.path}.${randomUUID()}.pending`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      const parent = await open(this.directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch {
      // A rename/fsync failure has an unknown durable outcome. Require reopen/reconciliation.
      this.failed = true;
      throw new HarnessHostError("journal_corrupt");
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) this.failed = true;
      });
    }
  }
}

async function journalLocation<T>(
  input: ObservationJournalOptions<T>,
): Promise<{ path: string; directory: string }> {
  if (
    !input.streamKey ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 256 ||
    input.maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(input.maxFrames) ||
    input.maxFrames < 1 ||
    input.maxFrames > 100_000
  )
    throw new HarnessHostError("journal_corrupt");
  const directory = await realpath(input.directory);
  const info = await stat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new HarnessHostError("journal_corrupt");
  return {
    directory,
    path: join(
      directory,
      `${createHash("sha256").update(input.streamKey).digest("hex")}.json`,
    ),
  };
}

async function readState<T>(
  path: string,
  input: ObservationJournalOptions<T>,
): Promise<JournalState<T>> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size > input.maxBytes ||
        (metadata.mode & 0o077) !== 0
      )
        throw new HarnessHostError("journal_corrupt");
      // Bound reads even if an invalid external writer grows a file after stat.
      const bytes = Buffer.alloc(input.maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > input.maxBytes)
        throw new HarnessHostError("journal_corrupt");
      return parseState(
        JSON.parse(bytes.subarray(0, length).toString("utf8")),
        input.streamKey,
        input.codec,
        input.maxFrames,
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw new HarnessHostError("journal_corrupt");
    return {
      version: 1,
      streamKey: input.streamKey,
      nextSequence: 1,
      frames: [],
    };
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseState<T>(
  value: unknown,
  streamKey: string,
  codec: ObservationJournalCodec<T>,
  maxFrames: number,
): JournalState<T> {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("streamKey" in value) ||
    value.streamKey !== streamKey ||
    !("nextSequence" in value) ||
    typeof value.nextSequence !== "number" ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 1 ||
    !("frames" in value) ||
    !Array.isArray(value.frames) ||
    value.frames.length > maxFrames
  ) {
    throw new HarnessHostError("journal_corrupt");
  }
  const frames: T[] = [];
  let previous = 0;
  for (const raw of value.frames) {
    const frame = codec.parse(raw);
    const sequence = codec.sequence(frame);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= previous ||
      sequence >= value.nextSequence
    ) {
      throw new HarnessHostError("journal_corrupt");
    }
    previous = sequence;
    frames.push(frame);
  }
  return { version: 1, streamKey, nextSequence: value.nextSequence, frames };
}
