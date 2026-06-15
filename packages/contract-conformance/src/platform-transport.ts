import { describe, expect, it } from "vitest";

interface CreateThreadRequestFixture {
  userId: string;
  workspaceId: string;
  title: string;
}

interface PlatformClientTransportContract {
  createThread(request: CreateThreadRequestFixture): Promise<unknown>;
}

export interface PlatformTransportConformanceFixture {
  transport: unknown;
  readCalls(): readonly { url: string; method: string | undefined }[];
}

export function registerPlatformTransportConformance(
  implementation: string,
  createFixture: (
    response: Response,
  ) => PlatformTransportConformanceFixture,
): void {
  describe(`${implementation} PlatformClientTransport conformance`, () => {
    it("sends create-thread input through the declared transport", async () => {
      const fixture = createFixture(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const transport = fixture.transport as PlatformClientTransportContract;
      await transport.createThread(createThreadRequest());

      expect(fixture.readCalls()).toEqual([
        { url: "https://conformance.test/threads", method: "POST" },
      ]);
    });

    it("maps protocol error envelopes to typed transport errors", async () => {
      const fixture = createFixture(
        new Response(
          JSON.stringify({
            error: {
              code: "not_found",
              message: "Thread not found",
              retryable: false,
              correlationId: "corr-conformance",
              details: null,
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      );

      await expect(
        (fixture.transport as PlatformClientTransportContract).createThread(
          createThreadRequest(),
        ),
      ).rejects.toMatchObject({
        code: "not_found",
        retryable: false,
        correlationId: "corr-conformance",
      });
    });
  });
}

function createThreadRequest(): CreateThreadRequestFixture {
  return {
    userId: "usr_conformance",
    workspaceId: "wrk_conformance",
    title: "Conformance thread",
  };
}
