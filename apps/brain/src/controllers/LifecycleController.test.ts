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

import { LifecycleController } from "./LifecycleController";

const RUN_ID = "run_123e4567e89b42d3a456426614174100";
const TURN_ID =
  "trn_123e4567e89b42d3a456426614174100__turn__client_msg_100";

describe("LifecycleController", () => {
  beforeEach(() => {
    runtimeHelpers.fetchRunRuntimeRoute.mockReset();
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    runtimeHelpers.withRunRepository.mockImplementation((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue({
          id: RUN_ID,
        }),
      }),
    );
    authHelpers.getAuthenticatedUserSession.mockResolvedValue({
      userId: "user-1",
      session: {},
    });
  });

  it("proxies durable lifecycle replay to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );

    const response = await LifecycleController.getEvents(
      new Request(
        `https://brain.local/turns/${TURN_ID}/lifecycle-events?afterSequence=4&limit=25`,
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      {
        method: "GET",
        path: `/lifecycle-events?turnId=${TURN_ID}&afterSequence=4&limit=25`,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [],
      nextSequence: null,
    });
  });

  it("proxies live lifecycle continuation to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      new Response('{"type":"turn.started"}\n', {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      }),
    );

    const response = await LifecycleController.getEventsStream(
      new Request(
        `https://brain.local/turns/${TURN_ID}/lifecycle-events/stream?afterSequence=5`,
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      {
        method: "GET",
        path: `/lifecycle-events/stream?turnId=${TURN_ID}&afterSequence=5`,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("turn.started");
  });

  it("rejects lifecycle replay when the user does not own the run", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );

    const response = await LifecycleController.getEvents(
      new Request(
        `https://brain.local/turns/${TURN_ID}/lifecycle-events`,
      ),
      {} as Env,
    );

    expect(response.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("proxies canonical turn diff reads to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ diff: null }),
    );

    const response = await LifecycleController.getTurnDiff(
      new Request(
        `https://brain.local/turns/${TURN_ID}/diff`,
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      {
        method: "GET",
        path: `/turn-diff?turnId=${TURN_ID}`,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ diff: null });
  });

  it("proxies lifecycle approval decisions to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({
        schemaVersion: 1,
        eventId: "evt_approvaldecision",
        idempotencyKey: "turn:approval:decision",
        producer: { kind: "runtime", id: "test" },
        occurredAt: "2026-07-03T00:00:00.000Z",
        sequence: 8,
        turnId: TURN_ID,
        type: "approval.decided",
        itemId: "itm_approvalitem",
        approvalId: "appr_123456",
        payload: { status: "approved" },
      }),
    );

    const response = await LifecycleController.submitApproval(
      new Request(
        `https://brain.local/turns/${TURN_ID}/approvals/appr_123456`,
        {
          method: "POST",
          body: JSON.stringify({
            turnId: TURN_ID,
            approvalId: "appr_123456",
            decision: "approved",
            decidedBy: null,
            reason: null,
          }),
        },
      ),
      env,
    );

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      {
        method: "POST",
        path: `/lifecycle-approval?turnId=${TURN_ID}&approvalId=appr_123456`,
        body: JSON.stringify({
          turnId: TURN_ID,
          approvalId: "appr_123456",
          decision: "approved",
          decidedBy: null,
          reason: null,
        }),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "approval.decided",
      approvalId: "appr_123456",
    });
  });
});
