import { describe, expect, it, vi } from "vitest";
import { releaseLeaseWhenResponseSettles } from "./AdmissionLeaseResponse";

describe("releaseLeaseWhenResponseSettles", () => {
  it("releases once after a streaming response completes", async () => {
    const release = vi.fn(async () => undefined);
    const response = releaseLeaseWhenResponseSettles(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("working"));
            controller.close();
          },
        }),
      ),
      release,
    );

    await response.text();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases once when a client cancels a streaming response", async () => {
    const release = vi.fn(async () => undefined);
    const response = releaseLeaseWhenResponseSettles(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            // Keep the response open until the client cancels it.
          },
        }),
      ),
      release,
    );

    await response.body?.cancel("client disconnected");

    expect(release).toHaveBeenCalledTimes(1);
  });
});
