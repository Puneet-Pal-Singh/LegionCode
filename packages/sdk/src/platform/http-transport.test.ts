import { describe, expect, it, vi } from "vitest";
import { registerPlatformTransportConformance } from "@repo/contract-conformance";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { createPlatformClient } from "./client.js";
import { createPlatformHttpTransport } from "./http-transport.js";
import { PlatformClientContractError } from "./errors.js";
import {
  TEST_IDS,
  createArtifact,
  createApprovalEvent,
  createApprovalRequest,
  createLifecycleEvent,
  createRun,
  createRunEvent,
  createRunRequest,
  createThread,
  createThreadRequest,
  createTurn,
  createTurnDiff,
} from "./test-fixtures.js";

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

function appServerResult(method: string, result: unknown): Response {
  return createJsonResponse({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    method,
    ok: true,
    result,
  });
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

  it("constructs thread, run, and artifact read endpoints", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input).includes("artifacts")) {
          return createJsonResponse({
            artifacts: [createArtifact()],
            nextCursor: TEST_IDS.nextCursor,
          });
        }
        if (String(input).includes("threads?")) {
          return createJsonResponse({
            threads: [createThread()],
            nextCursor: TEST_IDS.nextCursor,
          });
        }
        if (String(input).includes("threads/")) {
          return createJsonResponse(createThread());
        }
        return createJsonResponse(createRun());
      }),
    });
    const client = createPlatformClient(transport);

    await client.getThread(TEST_IDS.threadId);
    await client.listThreads({
      userId: TEST_IDS.userId,
      workspaceId: TEST_IDS.workspaceId,
      limit: 20,
    });
    await client.getRun(TEST_IDS.runId);
    await client.listArtifacts({
      runId: TEST_IDS.runId,
      afterCursor: TEST_IDS.cursor,
      limit: 20,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://control-plane.test/threads/thr_123456",
      "https://control-plane.test/threads?userId=usr_123456&workspaceId=wrk_123456&limit=20",
      "https://control-plane.test/runs/run_123456",
      "https://control-plane.test/runs/run_123456/artifacts?afterCursor=cursor_123456&limit=20",
    ]);
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

  it("starts turns and consumes lifecycle replay", async () => {
    const calls: FetchCall[] = [];
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input).endsWith("/turns")) {
          return createJsonResponse({ run: createRun(), turn: createTurn() });
        }
        return appServerResult("turn/lifecycleEvents", {
          events: [createLifecycleEvent(1)],
          nextSequence: 1,
        });
      }),
    });
    const client = createPlatformClient(transport);
    await client.startTurn(createRunRequest());
    await client.replayLifecycleEvents({
      turnId: TEST_IDS.turnId,
      afterSequence: 4,
      limit: 25,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://control-plane.test/turns",
      "https://control-plane.test/app-server/request",
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      method: "turn/lifecycleEvents",
      params: { turnId: TEST_IDS.turnId, afterSequence: 4, limit: 25 },
    });
  });

  it("maps protocol error envelopes to typed errors", async () => {
    let responseIndex = 0;
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: vi.fn(async () => {
        responseIndex += 1;
        if (responseIndex === 1) {
          return createJsonResponse(
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
          );
        }
        if (responseIndex === 2) return createJsonResponse({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "turn/lifecycleEvents",
          ok: false,
          error: {
            code: "not_found",
            message: "Run was not found",
            statusCode: 404,
            operationCode: "API_ERROR",
            retryable: false,
          },
        }, 404);
        if (responseIndex === 5) return createJsonResponse({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "turn/diff",
          ok: false,
          error: {
            code: "server_unavailable",
            message: "Invalid lifecycle response",
            statusCode: 502,
            operationCode: "INVALID_RESPONSE_CONTRACT",
            retryable: false,
          },
        }, 502);
        const protocolError = {
          code: "conflict",
          message: "Lifecycle request conflicted",
          retryable: responseIndex !== 3,
          correlationId: "corr-outer",
          details: null,
        };
        return createJsonResponse(responseIndex === 3 ? protocolError : { error: protocolError }, responseIndex === 3 ? 503 : 409);
      }),
    });
    const client = createPlatformClient(transport);

    await expect(client.createRun(createRunRequest())).rejects.toMatchObject({
      code: "not_found",
      correlationId: "corr-1",
      statusCode: 404,
      retryable: false,
    });
    await expect(client.replayLifecycleEvents({ turnId: TEST_IDS.turnId })).rejects.toMatchObject({
      code: "API_ERROR",
      statusCode: 404,
      retryable: false,
      message: "Run was not found",
    });
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toMatchObject({
      code: "conflict",
      statusCode: 503,
      retryable: false,
      correlationId: "corr-outer",
    });
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toMatchObject({
      code: "conflict",
      statusCode: 409,
      retryable: true,
      correlationId: "corr-outer",
    });
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toMatchObject({
      name: "PlatformClientContractError",
      phase: "response",
      operation: "getTurnDiff",
    });
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

  it("constructs lifecycle approval, user-input, and turn-diff endpoints", async () => {
    const calls: FetchCall[] = [];
    let diffResponseCount = 0;
    const transport = createPlatformHttpTransport({
      baseUrl: "https://control-plane.test",
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input).endsWith("/app-server/request")) {
          const envelope = JSON.parse(String(init?.body)) as { method: string };
          if (envelope.method === "turn/approval") {
            return appServerResult("turn/approval", createLifecycleEvent(2, {
              type: "approval.decided",
              itemId: TEST_IDS.approvalItemId,
              approvalId: TEST_IDS.approvalId,
              payload: { status: "approved", decision: "approved" },
            }));
          }
          diffResponseCount += 1;
          if (diffResponseCount === 2) return appServerResult("turn/diff", null);
          if (diffResponseCount === 3) return appServerResult("turn/diff", { diff: "wrong" });
          if (diffResponseCount === 4) {
            return new Response(JSON.stringify({
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: "turn/diff",
              ok: true,
              result: { diff: createTurnDiff() },
            }), { headers: { "Content-Type": "text/plain" } });
          }
          return appServerResult("turn/diff", { diff: createTurnDiff() });
        }
        if (String(input).includes("user-input")) {
          return createJsonResponse(
            createLifecycleEvent(3, {
              type: "user_input.responded",
              itemId: TEST_IDS.userInputItemId,
              requestId: "input_123456",
              payload: { value: "continue" },
            }),
          );
        }
        return createJsonResponse({ diff: createTurnDiff() });
      }),
    });
    const client = createPlatformClient(transport);

    await client.submitLifecycleApproval({
      turnId: TEST_IDS.turnId,
      approvalId: TEST_IDS.approvalId,
      decision: "approved",
      decidedBy: TEST_IDS.userId,
      reason: null,
    });
    await client.submitUserInputResponse({
      turnId: TEST_IDS.turnId,
      requestId: "input_123456",
      respondedBy: TEST_IDS.userId,
      response: { value: "continue" },
    });
    await client.getTurnDiff({ turnId: TEST_IDS.turnId });
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toBeInstanceOf(PlatformClientContractError);
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toBeInstanceOf(PlatformClientContractError);
    await expect(client.getTurnDiff({ turnId: TEST_IDS.turnId })).rejects.toMatchObject({
      code: "INVALID_RESPONSE_FORMAT",
      statusCode: 502,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://control-plane.test/app-server/request",
      "https://control-plane.test/turns/trn_123456/user-input/input_123456",
      "https://control-plane.test/app-server/request",
      "https://control-plane.test/app-server/request",
      "https://control-plane.test/app-server/request",
      "https://control-plane.test/app-server/request",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      method: "turn/approval",
      params: { turnId: TEST_IDS.turnId, approvalId: TEST_IDS.approvalId },
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({
      method: "turn/diff",
      params: { turnId: TEST_IDS.turnId },
    });
  });
});

registerPlatformTransportConformance("Platform HTTP transport", (response) => {
  const calls: FetchCall[] = [];
  return {
    transport: createPlatformHttpTransport({
      baseUrl: "https://conformance.test",
      fetchImpl: createFetch(response, calls),
    }),
    readCalls: () =>
      calls.map((call) => ({
        url: call.url,
        method: call.init.method,
      })),
  };
});
