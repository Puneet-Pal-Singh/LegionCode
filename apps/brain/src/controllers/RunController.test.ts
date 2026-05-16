import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";

const runtimeHelpers = vi.hoisted(() => ({
  fetchRunRuntimeRoute: vi.fn(),
  withRunRepository: vi.fn((_env, callback) => callback({
    getRun: vi.fn().mockResolvedValue(null),
    listRunEvents: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("./chat-runtime-helpers", () => ({
  fetchRunRuntimeRoute: runtimeHelpers.fetchRunRuntimeRoute,
}));

vi.mock("../services/runs/RunPersistenceFactory", () => ({
  withRunRepository: runtimeHelpers.withRunRepository,
}));

import { RunController } from "./RunController";

describe("RunController", () => {
  beforeEach(() => {
    runtimeHelpers.fetchRunRuntimeRoute.mockReset();
  });

  it("proxies canonical run events through the brain worker route", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response(
        [
          JSON.stringify({
            version: 1,
            eventId: "evt-1",
            runId: "123e4567-e89b-42d3-a456-426614174100",
            sessionId: "session-1",
            timestamp: "2026-03-24T12:00:00.000Z",
            source: "brain",
            type: "tool.requested",
            payload: {
              toolId: "tool-1",
              toolName: "read_file",
              arguments: { path: "README.md" },
            },
          }),
        ].join("\n"),
        {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
          },
        },
      ),
    );

    const response = await RunController.getEvents(
      new Request(
        "https://brain.local/api/run/events?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      "123e4567-e89b-42d3-a456-426614174100",
      "execution-engine-v1",
      {
        method: "GET",
        path: "/events?runId=123e4567-e89b-42d3-a456-426614174100",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    await expect(response.text()).resolves.toContain('"toolName":"read_file"');
  });

  it("proxies the live run events stream through the brain worker route", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response('{"eventId":"evt-live"}\n', {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
        },
      }),
    );

    const response = await RunController.getEventsStream(
      new Request(
        "https://brain.local/api/run/events/stream?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      "123e4567-e89b-42d3-a456-426614174100",
      "execution-engine-v1",
      {
        method: "GET",
        path: "/events/stream?runId=123e4567-e89b-42d3-a456-426614174100",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("evt-live");
  });

  it("proxies run activity snapshots through the brain worker route", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174101",
          sessionId: "session-1",
          status: "RUNNING",
          items: [
            {
              id: "tool-1",
              runId: "123e4567-e89b-42d3-a456-426614174101",
              sessionId: "session-1",
              kind: "tool",
              createdAt: "2026-03-24T12:00:00.000Z",
              updatedAt: "2026-03-24T12:00:01.000Z",
              source: "brain",
              toolId: "tool-1",
              toolName: "read_file",
              status: "completed",
              metadata: {
                family: "read",
                count: 1,
                truncated: false,
                loadedPaths: ["README.md"],
                path: "README.md",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const response = await RunController.getActivity(
      new Request(
        "https://brain.local/api/run/activity?runId=123e4567-e89b-42d3-a456-426614174101",
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      "123e4567-e89b-42d3-a456-426614174101",
      "execution-engine-v1",
      {
        method: "GET",
        path: "/activity?runId=123e4567-e89b-42d3-a456-426614174101",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      items: [{ toolName: "read_file" }],
    });
  });

  it("validates approval payloads before calling the runtime route", async () => {
    const env = {} as Env;

    const response = await RunController.approve(
      new Request("https://brain.local/api/run/approval", {
        method: "POST",
        body: JSON.stringify({ runId: "", requestId: "req-1" }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "runId, requestId, and decision are required",
    });
  });

  it("proxies approval decisions through the brain worker route", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174102",
          requestId: "req-1",
          decision: "allow_once",
          status: "approved",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const response = await RunController.approve(
      new Request("https://brain.local/api/run/approval", {
        method: "POST",
        body: JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174102",
          requestId: "req-1",
          decision: "allow_once",
          orchestratorBackend: "cloudflare_agents",
        }),
      }),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      "123e4567-e89b-42d3-a456-426614174102",
      "cloudflare_agents",
      {
        method: "POST",
        path: "/approval",
        body: JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174102",
          requestId: "req-1",
          decision: "allow_once",
        }),
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      decision: "allow_once",
      status: "approved",
    });
  });

  it("returns 409 when an approval resolve targets a stale pending request", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockRejectedValueOnce(
      new Error("No pending approval request found."),
    );

    const response = await RunController.approve(
      new Request("https://brain.local/api/run/approval", {
        method: "POST",
        body: JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174102",
          requestId: "req-stale",
          decision: "allow_once",
        }),
      }),
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "No pending approval request found.",
    });
  });
});
