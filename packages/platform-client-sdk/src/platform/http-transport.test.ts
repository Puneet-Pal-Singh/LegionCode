import { describe, expect, it, vi } from "vitest";
import { createPlatformClient } from "./client.js";
import {
  PlatformClientOperationError,
} from "./errors.js";
import { createPlatformHttpTransport } from "./http-transport.js";
import {
  TEST_IDS,
  createAppendRunEventRequest,
  createApprovalEvent,
  createApprovalRequest,
  createRun,
  createRunEvent,
  createRunRequest,
  createThread,
  createThreadRequest,
} from "./test-fixtures.js";
import type { RunEvent } from "@repo/platform-protocol";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createNdjsonResponse(...payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
  );
}

function createFetch(
  response: Response,
  calls: FetchCall[] = [],
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init: init ?? {},
    });
    return response;
  });
}

describe("createPlatformHttpTransport", () => {
  it("constructs createThread requests without hardcoded absolute URLs", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test/api/",
      fetchImpl: createFetch(createJsonResponse(createThread()), calls),
      getHeaders: () => ({
        Authorization: "Bearer token",
        "Content-Type": "text/plain",
      }),
    });
    const client = createPlatformClient(transport);

    await client.createThread(createThreadRequest());

    expect(calls).toEqual([
      {
        url: "https://control-plane.test/api/threads",
        init: expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify(createThreadRequest()),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer token",
          },
        }) as RequestInit,
      },
    ]);
  });

  it("posts appendRunEvent to the run-scoped event endpoint", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: createFetch(createJsonResponse(createRunEvent()), calls),
    });
    const client = createPlatformClient(transport);
    const request = createAppendRunEventRequest();

    await client.appendRunEvent(request);

    expect(calls[0]?.url).toBe(
      "https://control-plane.test/runs/run_123456/events",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request);
  });

  it("attaches run streams as typed NDJSON events", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: createFetch(createNdjsonResponse(createRunEvent()), calls),
    });
    const client = createPlatformClient(transport);
    const events: RunEvent[] = [];

    for await (const event of client.attachRunStream({
      runId: TEST_IDS.runId,
      afterCursor: TEST_IDS.cursor,
    })) {
      events.push(event);
    }

    expect(calls[0]?.url).toBe(
      "https://control-plane.test/runs/run_123456/events/stream?afterCursor=cursor_123456",
    );
    expect(calls[0]?.init.headers).toEqual({
      Accept: "application/x-ndjson",
    });
    expect(events).toEqual([createRunEvent()]);
  });

  it("replays run events with cursor and limit query parameters", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: createFetch(
        createJsonResponse({
          events: [createRunEvent()],
          nextCursor: TEST_IDS.nextCursor,
        }),
        calls,
      ),
    });
    const client = createPlatformClient(transport);

    await expect(
      client.replayRunEvents({
        runId: TEST_IDS.runId,
        afterCursor: TEST_IDS.cursor,
        limit: 25,
      }),
    ).resolves.toEqual({
      events: [createRunEvent()],
      nextCursor: TEST_IDS.nextCursor,
    });
    expect(calls[0]?.url).toBe(
      "https://control-plane.test/runs/run_123456/events?afterCursor=cursor_123456&limit=25",
    );
  });

  it("maps protocol error envelopes to typed errors", async () => {
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: createFetch(
        createJsonResponse(
          {
            error: {
              code: "not_found",
              message: "Run was not found",
              retryable: false,
              correlationId: "corr-1",
              details: null,
            },
          },
          404,
        ),
      ),
    });
    const client = createPlatformClient(transport);

    await expect(client.createRun(createRunRequest())).rejects.toMatchObject({
      code: "not_found",
      correlationId: "corr-1",
      statusCode: 404,
      retryable: false,
    });
  });

  it("fails stream attachment on malformed NDJSON", async () => {
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: createFetch(
        new Response("{bad-json}\n", {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      ),
    });
    const client = createPlatformClient(transport);
    const stream = client.attachRunStream({ runId: TEST_IDS.runId });

    await expect(readAll(stream)).rejects.toBeInstanceOf(
      PlatformClientOperationError,
    );
  });

  it("constructs approval and run resource endpoints", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input).includes("approvals")) {
          return createJsonResponse(createApprovalEvent());
        }
        return createJsonResponse(createRun());
      }),
    });
    const client = createPlatformClient(transport);

    await client.submitApproval(createApprovalRequest());
    await client.getWorkspaceManifest(TEST_IDS.runId).catch(() => undefined);

    expect(calls[0]?.url).toBe(
      "https://control-plane.test/runs/run_123456/approvals/appr_123456",
    );
    expect(calls[1]?.url).toBe(
      "https://control-plane.test/runs/run_123456/workspace-manifest",
    );
  });
});

async function readAll<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}
