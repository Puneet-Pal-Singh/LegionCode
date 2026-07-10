import { redactUserFacingOutput } from "./RunOutputRedactor.js";

export function createStreamResponse(content: string): Response {
  const safeContent = redactUserFacingOutput(content);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(safeContent));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
