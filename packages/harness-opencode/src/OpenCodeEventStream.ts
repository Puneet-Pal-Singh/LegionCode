import type { OpenCodeEvent } from "@opencode/client";
import { OpenCodeEvent as EventSchema } from "@opencode/protocol/groups/event";
import { Schema } from "effect";

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
  let pending = "";
  let data: string[] = [];
  let frameBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("OpenCode event continuity ended.");
      input.activity();
      if (chunk.value.byteLength > MAX_FRAME_BYTES)
        throw new Error("OpenCode event frame bound exceeded.");
      pending += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(pending, "utf8") + frameBytes > MAX_FRAME_BYTES)
        throw new Error("OpenCode event frame bound exceeded.");
      let match: RegExpExecArray | null;
      const newline = /\r\n|\r|\n/gu;
      let consumed = 0;
      while ((match = newline.exec(pending)) !== null) {
        // Keep a final CR until the next chunk so split CRLF is exactly one newline.
        if (match[0] === "\r" && match.index === pending.length - 1) break;
        const line = pending.slice(consumed, match.index);
        consumed = newline.lastIndex;
        frameBytes += Buffer.byteLength(line, "utf8") + match[0].length;
        if (frameBytes > MAX_FRAME_BYTES)
          throw new Error("OpenCode event frame bound exceeded.");
        if (line === "") {
          if (data.length) {
            const value: unknown = JSON.parse(data.join("\n"));
            if (!isEvent(value)) throw new Error("Invalid OpenCode event.");
            data = [];
            frameBytes = 0;
            yield value;
          } else frameBytes = 0;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
      }
      pending = pending.slice(consumed);
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
