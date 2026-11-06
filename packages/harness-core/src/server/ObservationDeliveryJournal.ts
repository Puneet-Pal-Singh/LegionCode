import { constants } from "node:fs";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HarnessHostError } from "./errors.js";

export interface ObservationJournalCodec<T> {
  /** Use the canonical worker-protocol schema, including the exact stream binding. */
  parse(value: unknown): T;
  sequence(frame: T): number;
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

  private constructor(
    private readonly path: string,
    private readonly directory: string,
    private readonly codec: ObservationJournalCodec<T>,
    private readonly limits: {
      readonly maxBytes: number;
      readonly maxFrames: number;
    },
    private state: JournalState<T>,
  ) {}

  static async open<T>(input: {
    readonly directory: string;
    /** Exact canonical attempt/instance/external-session/process-generation identity. */
    readonly streamKey: string;
    readonly codec: ObservationJournalCodec<T>;
    readonly maxBytes: number;
    readonly maxFrames: number;
  }): Promise<ObservationDeliveryJournal<T>> {
    if (
      !input.streamKey ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 256 ||
      input.maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(input.maxFrames) ||
      input.maxFrames < 1 ||
      input.maxFrames > 100_000
    ) {
      throw new HarnessHostError("journal_corrupt");
    }
    // Composition supplies a private instance directory, outside workspace/artifact roots.
    const directory = await realpath(input.directory);
    const info = await stat(directory);
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      throw new HarnessHostError("journal_corrupt");
    }
    const path = join(
      directory,
      `${createHash("sha256").update(input.streamKey).digest("hex")}.json`,
    );
    let state: JournalState<T> = {
      version: 1,
      streamKey: input.streamKey,
      nextSequence: 1,
      frames: [],
    };
    try {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.size > input.maxBytes ||
          (metadata.mode & 0o077) !== 0
        ) {
          throw new HarnessHostError("journal_corrupt");
        }
        state = parseState(
          JSON.parse(await handle.readFile("utf8")),
          input.streamKey,
          input.codec,
          input.maxFrames,
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isMissing(error)) throw new HarnessHostError("journal_corrupt");
    }
    return new ObservationDeliveryJournal(
      path,
      directory,
      input.codec,
      input,
      state,
    );
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
    const result = this.queue.then(() => {
      if (this.failed) throw new HarnessHostError("journal_corrupt");
      return action();
    });
    this.queue = result.catch(() => undefined);
    return result;
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
