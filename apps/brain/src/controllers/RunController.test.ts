import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";

const runtimeHelpers = vi.hoisted(() => ({
  fetchRunRuntimeRoute: vi.fn(),
  withRunRepository: vi.fn(),
}));

const authHelpers = vi.hoisted(() => ({
  getAuthenticatedUserSession: vi.fn(),
  isSessionStoreUnavailableError: vi.fn(() => false),
}));

vi.mock("./chat-runtime-helpers", () => ({
  fetchRunRuntimeRoute: runtimeHelpers.fetchRunRuntimeRoute,
}));

vi.mock("../services/runs/RunPersistenceFactory", () => ({
  withRunRepository: runtimeHelpers.withRunRepository,
}));

vi.mock("../services/AuthService", () => ({
  getAuthenticatedUserSession: authHelpers.getAuthenticatedUserSession,
  isSessionStoreUnavailableError: authHelpers.isSessionStoreUnavailableError,
}));

import { RunController } from "./RunController";

describe("RunController", () => {
  beforeEach(() => {
    runtimeHelpers.fetchRunRuntimeRoute.mockReset();
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    runtimeHelpers.withRunRepository.mockImplementation((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue({
          id: "123e4567-e89b-42d3-a456-426614174100",
          status: "running",
        }),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );
    authHelpers.getAuthenticatedUserSession.mockResolvedValue({
      userId: "user-1",
      session: {},
    });
  });

  it("returns canonical run events from Postgres scoped by user", async () => {
    const env = {} as Env;
    const run = {
      id: "123e4567-e89b-42d3-a456-426614174100",
      status: "running",
    };
    const event = {
      id: "evt-1",
      runId: run.id,
      sessionId: "123e4567-e89b-42d3-a456-426614174200",
      eventType: "tool.requested",
      payload: { toolName: "read_file" },
      sequence: 1,
      idempotencyKey: "key-1",
      createdAt: "2026-03-24T12:00:00.000Z",
    };
    const getRun = vi.fn().mockResolvedValue(run);
    const listRunEvents = vi.fn().mockResolvedValue([event]);
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun,
        listRunEvents,
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );

    const response = await RunController.getEvents(
      new Request(
        "https://brain.local/api/run/events?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    expect(getRun).toHaveBeenCalledWith(
      "123e4567-e89b-42d3-a456-426614174100",
      "user-1",
    );
    expect(listRunEvents).toHaveBeenCalledWith(run.id, "user-1");
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([event]);
  });

  it("reconstructs run summary from Postgres steps and events", async () => {
    const env = {} as Env;
    const run = {
      id: "123e4567-e89b-42d3-a456-426614174100",
      status: "completed",
    };
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(run),
        listRunEvents: vi
          .fn()
          .mockResolvedValue([
            { eventType: "tool.started" },
            { eventType: "tool.completed" },
          ]),
        listRunSteps: vi.fn().mockResolvedValue([
          {
            status: "completed",
            stepType: "tool",
            payload: { toolName: "read_file" },
          },
          {
            status: "failed",
            stepType: "tool",
            payload: { toolName: "npm_test" },
          },
          {
            status: "pending",
            stepType: "tool",
            payload: { toolName: "build" },
          },
        ]),
      }),
    );

    const response = await RunController.getSummary(
      new Request(
        "https://brain.local/api/run/summary?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      run.id,
      "execution-engine-v1",
      {
        method: "GET",
        path: `/summary?runId=${encodeURIComponent(run.id)}`,
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      runId: run.id,
      status: "completed",
      totalTasks: 3,
      completedTasks: 1,
      failedTasks: 1,
      pendingTasks: 1,
      eventCount: 2,
      lastEventType: "tool.completed",
      terminalState: "completed",
      terminalMessage: {
        lastSuccessfulStep: "read_file",
        failedStep: "npm_test",
        nextAction:
          "Review the changed files, then send the next task when ready.",
      },
    });
  });

  it("overlays default run summary with live runtime terminal status", async () => {
    const env = {} as Env;
    const run = {
      id: "123e4567-e89b-42d3-a456-426614174100",
      status: "running",
    };
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(run),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([{ status: "running" }]),
      }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: run.id,
          status: "COMPLETED",
          totalTasks: 1,
          completedTasks: 1,
          failedTasks: 0,
          runningTasks: 0,
          pendingTasks: 0,
          cancelledTasks: 0,
          eventCount: 3,
          lastEventType: "run.completed",
        }),
        { status: 200 },
      ),
    );

    const response = await RunController.getSummary(
      new Request(
        "https://brain.local/api/run/summary?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      runId: run.id,
      status: "COMPLETED",
      completedTasks: 1,
      runningTasks: 0,
      lastEventType: "run.completed",
    });
  });

  it("does not revive a terminal Postgres run with stale active runtime status", async () => {
    const env = {} as Env;
    const run = {
      id: "123e4567-e89b-42d3-a456-426614174100",
      status: "completed",
    };
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(run),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([{ status: "completed" }]),
      }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: run.id,
          status: "RUNNING",
          totalTasks: 1,
          completedTasks: 0,
          failedTasks: 0,
          runningTasks: 1,
          pendingTasks: 0,
          cancelledTasks: 0,
        }),
        { status: 200 },
      ),
    );

    const response = await RunController.getSummary(
      new Request(
        "https://brain.local/api/run/summary?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      runId: run.id,
      status: "completed",
    });
  });

  it("proxies the live run events stream through the brain worker route", async () => {
    const env = {} as Env;
    const runtimeResponse = new Response('{"eventId":"evt-live"}\n', {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(runtimeResponse);

    const response = await RunController.getEventsStream(
      new Request(
        "https://brain.local/api/run/events/stream?runId=123e4567-e89b-42d3-a456-426614174100",
        { headers: { Origin: "http://localhost:5173" } },
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
        headers: { Origin: "http://localhost:5173" },
      },
    );
    expect(response).toBe(runtimeResponse);
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

  it("rejects cancel without an authenticated session", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);
    const env = {} as Env;

    const response = await RunController.cancel(
      new Request("https://brain.local/api/run/cancel", {
        method: "POST",
        body: JSON.stringify({ runId: "123e4567-e89b-42d3-a456-426614174100" }),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects cancel when the run is not owned by the user", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(null),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );
    const env = {} as Env;

    const response = await RunController.cancel(
      new Request("https://brain.local/api/run/cancel", {
        method: "POST",
        body: JSON.stringify({ runId: "victim-run-id" }),
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects approve without an authenticated session", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);
    const env = {} as Env;

    const response = await RunController.approve(
      new Request("https://brain.local/api/run/approval", {
        method: "POST",
        body: JSON.stringify({
          runId: "123e4567-e89b-42d3-a456-426614174100",
          requestId: "req-1",
          decision: "allow_once",
        }),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects approve when the run is not owned by the user", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(null),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );
    const env = {} as Env;

    const response = await RunController.approve(
      new Request("https://brain.local/api/run/approval", {
        method: "POST",
        body: JSON.stringify({
          runId: "victim-run-id",
          requestId: "req-1",
          decision: "allow_once",
        }),
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects getEventsStream without an authenticated session", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);
    const env = {} as Env;

    const response = await RunController.getEventsStream(
      new Request(
        "https://brain.local/api/run/events/stream?runId=123e4567-e89b-42d3-a456-426614174100",
        { headers: { Origin: "http://localhost:5173" } },
      ),
      env,
    );

    expect(response.status).toBe(401);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects getEventsStream when the run is not owned by the user", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(null),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );
    const env = {} as Env;

    const response = await RunController.getEventsStream(
      new Request(
        "https://brain.local/api/run/events/stream?runId=victim-run-id",
        { headers: { Origin: "http://localhost:5173" } },
      ),
      env,
    );

    expect(response.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects getActivity without an authenticated session", async () => {
    authHelpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);
    const env = {} as Env;

    const response = await RunController.getActivity(
      new Request(
        "https://brain.local/api/run/activity?runId=123e4567-e89b-42d3-a456-426614174100",
      ),
      env,
    );

    expect(response.status).toBe(401);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("rejects getActivity when the run is not owned by the user", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue(null),
        listRunEvents: vi.fn().mockResolvedValue([]),
        listRunSteps: vi.fn().mockResolvedValue([]),
      }),
    );
    const env = {} as Env;

    const response = await RunController.getActivity(
      new Request("https://brain.local/api/run/activity?runId=victim-run-id"),
      env,
    );

    expect(response.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });
});
