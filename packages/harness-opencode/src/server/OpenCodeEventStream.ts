import type { OpenCodeEvent } from "@opencode/client";
import { OpenCodeEvent as EventSchema } from "@opencode/protocol/groups/event";
import { Schema } from "effect";

/** Clean EOF is only expected after an independently attested completion barrier. */
export class OpenCodeStreamEnded extends Error {
  constructor() {
    super("OpenCode event continuity ended.");
  }
}

const MAX_FRAME_BYTES = 1_048_576;
const validEvent = Schema.is(Schema.toEncoded(EventSchema));

/** Serial native SSE: no second producer queue can outrun the durable observation sink. */
export async function* readOpenCodeEvents(input: {
  readonly origin: string;
  readonly authorization: string;
  readonly signal: AbortSignal;
  readonly activity: () => void;
}): AsyncGenerator<OpenCodeEvent> {
  const response = await fetch(`${input.origin}/api/event`, {
    headers: {
      Authorization: input.authorization,
      Accept: "text/event-stream",
    },
    signal: input.signal,
    redirect: "error",
  });
  if (
    response.status !== 200 ||
    !/^text\/event-stream(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("OpenCode event subscription was not accepted.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Keep unfinished lines in one bounded allocation. Tiny HTTP chunks must not
  // rescan/copy the accumulated prefix or create one retained string per chunk.
  const lineBuffer = Buffer.alloc(MAX_FRAME_BYTES);
  let lineBytes = 0;
  let pendingCR = false;
  let data: string[] = [];
  let frameBytes = 0;
  const appendLine = (text: string) => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (frameBytes + lineBytes + bytes > MAX_FRAME_BYTES)
      throw new Error("OpenCode event frame bound exceeded.");
    lineBuffer.write(text, lineBytes, bytes, "utf8");
    lineBytes += bytes;
  };
  const finishLine = (separatorBytes: number): OpenCodeEvent | undefined => {
    frameBytes += lineBytes + separatorBytes;
    if (frameBytes > MAX_FRAME_BYTES)
      throw new Error("OpenCode event frame bound exceeded.");
    const line = lineBuffer.toString("utf8", 0, lineBytes);
    lineBytes = 0;
    if (line === "") {
      if (data.length) {
        const value: unknown = JSON.parse(data.join("\n"));
        if (!isEvent(value)) throw new Error("Invalid OpenCode event.");
        data = [];
        frameBytes = 0;
        return value;
      }
      frameBytes = 0;
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return undefined;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new OpenCodeStreamEnded();
      input.activity();
      // HTTP chunks are not SSE frames. Decode bounded slices, then enforce the
      // limit on each frame and its unfinished line, including split UTF-8/CRLF.
      for (let offset = 0; offset < chunk.value.byteLength; offset += 16384) {
        const text = decoder.decode(
          chunk.value.subarray(offset, offset + 16384),
          {
            stream: true,
          },
        );
        let consumed = 0;
        if (pendingCR && text.length) {
          pendingCR = false;
          const crlf = text.startsWith("\n");
          const event = finishLine(crlf ? 2 : 1);
          if (event) yield event;
          if (crlf) consumed = 1;
        }
        let match: RegExpExecArray | null;
        const newline = /\r\n|\r|\n/gu;
        newline.lastIndex = consumed;
        while ((match = newline.exec(text)) !== null) {
          appendLine(text.slice(consumed, match.index));
          consumed = newline.lastIndex;
          // Keep a final CR until the next chunk so split CRLF is exactly one newline.
          if (match[0] === "\r" && match.index === text.length - 1) {
            pendingCR = true;
            break;
          }
          const event = finishLine(match[0].length);
          if (event) yield event;
        }
        appendLine(text.slice(consumed));
        if (frameBytes + lineBytes + (pendingCR ? 1 : 0) > MAX_FRAME_BYTES)
          throw new Error("OpenCode event frame bound exceeded.");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function isEvent(value: unknown): value is OpenCodeEvent {
  return validEvent(value);
}
