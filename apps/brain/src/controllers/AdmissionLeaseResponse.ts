/**
 * Keeps a run-admission lease alive for the lifetime of the client response.
 * A service-binding fetch resolves when response headers arrive, while the
 * execution stream may still be running; releasing at that point defeats the
 * concurrency policy.
 */
export function releaseLeaseWhenResponseSettles(
  response: Response,
  release: () => Promise<void>,
): Response {
  let releasePromise: Promise<void> | undefined;
  const settle = (): Promise<void> => {
    releasePromise ??= release();
    return releasePromise;
  };

  if (!response.body) {
    void settle();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await settle();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        await settle();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settle();
      }
    },
  });

  return new Response(body, response);
}
