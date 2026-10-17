import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";

const runtimeHelpers = vi.hoisted(() => ({
  fetchRunRuntimeRoute: vi.fn(),
  withRunRepository: vi.fn(),
  withTurnAdmissionRepository: vi.fn(),
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

vi.mock("../services/turn-admissions/TurnAdmissionPersistenceFactory", () => ({
  withTurnAdmissionRepository: runtimeHelpers.withTurnAdmissionRepository,
}));

vi.mock("../services/AuthService", () => ({
  getAuthenticatedUserSession: authHelpers.getAuthenticatedUserSession,
  isSessionStoreUnavailableError: authHelpers.isSessionStoreUnavailableError,
}));

import { LifecycleController } from "./LifecycleController";

const RUN_ID = "run_123e4567e89b42d3a456426614174100";
const TURN_ID = "trn_123e4567e89b42d3a456426614174100__turn__client_msg_100";

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
    runtimeHelpers.withTurnAdmissionRepository.mockImplementation(
      (_env, callback) =>
        callback({ getByTurnId: vi.fn().mockResolvedValue(null) }),
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

    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) =>
        callback({
          getByTurnId: vi.fn().mockResolvedValue({
            userId: "user-1",
            runId: RUN_ID,
            state: "reserved",
          }),
        }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );
    const reservedReplay = await LifecycleController.getEvents(
      new Request(`https://brain.local/turns/${TURN_ID}/lifecycle-events`),
      env,
    );
    expect(reservedReplay.status).toBe(200);

    const getRun = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: RUN_ID });
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun }),
    );
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) =>
        callback({
          getByTurnId: vi.fn().mockResolvedValue({
            userId: "user-1",
            runId: RUN_ID,
            state: "admitted",
          }),
        }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );
    const admittedReplay = await LifecycleController.getEvents(
      new Request(`https://brain.local/turns/${TURN_ID}/lifecycle-events`),
      env,
    );
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(admittedReplay.status).toBe(200);
  });

  it("rejects lifecycle replay when the user does not own the run", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );

    const response = await LifecycleController.getEvents(
      new Request(`https://brain.local/turns/${TURN_ID}/lifecycle-events`),
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
      new Request(`https://brain.local/turns/${TURN_ID}/diff`),
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

    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) =>
        callback({
          getByTurnId: vi.fn().mockResolvedValue({
            userId: "user-1",
            runId: RUN_ID,
            state: "reserved",
          }),
        }),
    );
    const deniedDiff = await LifecycleController.getTurnDiff(
      new Request(`https://brain.local/turns/${TURN_ID}/diff`),
      env,
    );
    expect(deniedDiff.status).toBe(404);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledTimes(1);
  });

  it("proxies lifecycle approval decisions to the owning runtime", async () => {
    const env = {} as Env;
    const submit = (payload: Record<string, unknown>) =>
      LifecycleController.submitApproval(
        new Request(
          `https://brain.local/turns/${TURN_ID}/approvals/appr_123456`,
          { method: "POST", body: JSON.stringify(payload) },
        ),
        env,
      );
    const matchingScopePayload = {
      turnId: TURN_ID,
      approvalId: "appr_123456",
      decision: "approved",
      grantScope: "matching_in_chat",
      decidedBy: null,
      reason: null,
    };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ type: "approval.decided", approvalId: "appr_123456" }),
    );

    const response = await submit(matchingScopePayload);

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      1,
      env,
      RUN_ID,
      "execution-engine-v1",
      {
        method: "POST",
        path: `/lifecycle-approval?turnId=${TURN_ID}&approvalId=appr_123456`,
        body: JSON.stringify(matchingScopePayload),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "approval.decided",
    });

    const oncePayload = { ...matchingScopePayload, grantScope: "once" };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({}),
    );
    expect((await submit(oncePayload)).status).toBe(200);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      2,
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({ body: JSON.stringify(oncePayload) }),
    );

    const defaultPayload: Record<string, unknown> = {
      ...matchingScopePayload,
    };
    delete defaultPayload.grantScope;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({}),
    );
    expect((await submit(defaultPayload)).status).toBe(200);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      3,
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({ body: JSON.stringify(defaultPayload) }),
    );

    const beforeInvalidScope =
      runtimeHelpers.fetchRunRuntimeRoute.mock.calls.length;
    expect(
      (await submit({ ...matchingScopePayload, grantScope: "invalid" })).status,
    ).toBe(400);
    expect(
      (await submit({ ...matchingScopePayload, decision: "denied" })).status,
    ).toBe(400);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledTimes(
      beforeInvalidScope,
    );
  });
});
