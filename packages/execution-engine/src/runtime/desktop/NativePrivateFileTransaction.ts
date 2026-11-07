import type { Writable } from "node:stream";

/** Channel owned by NativeFilesystemBridge; this module launches no process. */
export interface NativePrivateTransactionChannel {
  read(length: number): Promise<Buffer>;
  length(maximum: number): Promise<number>;
  tag(expected: number): Promise<void>;
}

export interface NativePrivateFileTransaction {
  readonly privateDirectory: string;
  readonly originalExists: boolean;
  readonly finalized: boolean;
  filePath(name: string): string;
  verify(): Promise<void>;
  inspectExecutables(paths: readonly string[]): Promise<readonly (0 | 1 | 2)[]>;
  publish(source: string): Promise<void>;
  abort(): Promise<void>;
  /** Close while retaining the owned lock and private recovery evidence. */
  quarantine(): Promise<void>;
}

function leaf(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\0/\\]/u.test(name) ||
    Buffer.byteLength(name) > 128
  )
    throw new Error("Private file transaction requires a bounded leaf name");
}
export function validatePrivateDirectoryPath(path: string): void {
  if (
    !path ||
    Buffer.byteLength(path) > 500 ||
    path.startsWith("/") ||
    /[\0\\]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    Buffer.from(path).toString("utf8") !== path
  )
    throw new Error("Private file transaction requires a rooted relative path");
}
function frame(value: string): Buffer {
  const bytes = Buffer.from(value),
    length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function send(pipe: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    pipe.write(bytes, (error?: Error | null) =>
      error ? reject(error) : resolve(),
    ),
  );
}

export async function openNativePrivateFileTransaction(options: {
  readonly directory: string;
  readonly file: string;
  readonly reader: NativePrivateTransactionChannel;
  readonly pipe: Writable;
  readonly beforePublish: () => Promise<void>;
}): Promise<NativePrivateFileTransaction> {
  leaf(options.file);
  await send(options.pipe, frame(options.file));
  await options.reader.tag(84);
  const exists = (await options.reader.read(1))[0];
  if (exists !== 0 && exists !== 1)
    throw new Error("Invalid native transaction source state");
  const name = (
    await options.reader.read(await options.reader.length(128))
  ).toString("utf8");
  if (!/^\.legioncode-transaction-[a-f0-9]{32}$/u.test(name))
    throw new Error("Invalid private directory receipt");
  const directory = `${options.directory}/${name}`;
  let finalized = false;
  const active = () => {
    if (finalized)
      throw new Error("Native private file transaction is already closed");
  };
  const finish = async (tag: "A" | "Q") => {
    active();
    await send(options.pipe, Buffer.from(tag));
    await options.reader.tag(tag.charCodeAt(0));
    finalized = true;
  };
  return {
    privateDirectory: directory,
    originalExists: exists === 1,
    get finalized() {
      return finalized;
    },
    filePath(name) {
      leaf(name);
      return `${directory}/${name}`;
    },
    async verify() {
      active();
      await send(options.pipe, Buffer.from("V"));
      await options.reader.tag(86);
    },
    async inspectExecutables(paths) {
      active();
      if (paths.length > 32)
        throw new Error("Private executable inspection exceeds its bound");
      const answers: (0 | 1 | 2)[] = [];
      for (const path of paths) {
        validatePrivateDirectoryPath(path);
        await send(
          options.pipe,
          Buffer.concat([Buffer.from("H"), frame(path)]),
        );
        await options.reader.tag(72);
        const answer = (await options.reader.read(1))[0];
        if (answer !== 0 && answer !== 1 && answer !== 2)
          throw new Error("Invalid private executable receipt");
        answers.push(answer);
      }
      return answers;
    },
    async publish(source) {
      active();
      leaf(source);
      await options.beforePublish();
      await send(
        options.pipe,
        Buffer.concat([Buffer.from("P"), frame(source)]),
      );
      await options.reader.tag(80);
      finalized = true;
    },
    abort: () => finish("A"),
    quarantine: () => finish("Q"),
  };
}
