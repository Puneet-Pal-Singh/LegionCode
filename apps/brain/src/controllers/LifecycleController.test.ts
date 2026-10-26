import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";
import { APP_SERVER_PROTOCOL_VERSION, AppServerRequestSchema } from "@legioncode/app-server/protocol";
import { composeHostedLifecycleOperations } from "../integration/app-server/HostedLifecycleOperations";

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

vi.mock("../services/AuthService", () => ({
  getAuthenticatedUserSession: authHelpers.getAuthenticatedUserSession,
  isSessionStoreUnavailableError: authHelpers.isSessionStoreUnavailableError,
}));

import { AppServerController } from "./AppServerController";
vi.mock("../services/turn-admissions/TurnAdmissionPersistenceFactory", () => ({
  withTurnAdmissionRepository: runtimeHelpers.withTurnAdmissionRepository,
}));


const RUN_ID = "run_123e4567e89b42d3a456426614174100";
const TURN_ID = "trn_123e4567e89b42d3a456426614174100__turn__client_msg_100";
const USER_ID = "usr_123456";

function operations(env: Env) {
  return composeHostedLifecycleOperations(
    new Request("https://brain.local/app-server/request", { method: "POST" }),
    env,
    USER_ID,
  );
}

describe("LifecycleController", () => {
  beforeEach(() => {
    runtimeHelpers.fetchRunRuntimeRoute.mockReset();
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    runtimeHelpers.withRunRepository.mockImplementation((_env, callback) =>
      callback({
        getRun: vi.fn().mockResolvedValue({ id: RUN_ID }),
      }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementation(
      (_env, callback) => callback({ getByTurnId: vi.fn().mockResolvedValue(null) }),
    );
    authHelpers.getAuthenticatedUserSession.mockResolvedValue({ userId: USER_ID, session: {} });
  });

  it("proxies durable lifecycle replay to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );

    const response = await operations(env).replayLifecycleEvents({
      turnId: TURN_ID,
      afterSequence: 4,
      limit: 25,
    });

    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({
        method: "GET",
        path: `/lifecycle-events?turnId=${TURN_ID}&afterSequence=4&limit=25`,
      }),
    );
    expect(response).toEqual({ events: [], nextSequence: null });

    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) => callback({
        getByTurnId: vi.fn().mockResolvedValue({ userId: USER_ID, runId: RUN_ID, state: "reserved" }),
      }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );
    await expect(operations(env).replayLifecycleEvents({ turnId: TURN_ID })).resolves.toEqual({
      events: [], nextSequence: null,
    });

    const getRun = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: RUN_ID });
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) => callback({ getRun }));
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) => callback({ getRun }));
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) => callback({
        getByTurnId: vi.fn().mockResolvedValue({ userId: USER_ID, runId: RUN_ID, state: "admitted" }),
      }),
    );
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );
    await operations(env).replayLifecycleEvents({ turnId: TURN_ID });
    expect(getRun).toHaveBeenCalledTimes(2);

    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(
      Response.json({ events: [], nextSequence: null }),
    );
    const hostedResponse = await AppServerController.request(
      new Request("https://brain.local/app-server/request", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=verified" },
        body: JSON.stringify({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "turn/lifecycleEvents",
          params: { turnId: TURN_ID, afterSequence: 4, limit: 25 },
        }),
      }),
      {} as Env,
    );
    expect(hostedResponse.status).toBe(200);
    await expect(hostedResponse.json()).resolves.toMatchObject({
      method: "turn/lifecycleEvents",
      ok: true,
      result: { events: [], nextSequence: null },
    });
    expect(runtimeHelpers.withRunRepository).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Function),
    );
  });

  it("rejects lifecycle replay when the user does not own the run", async () => {
    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );

    await expect(operations({} as Env).replayLifecycleEvents({ turnId: TURN_ID }))
      .rejects.toMatchObject({ statusCode: 404, operationCode: "API_ERROR" });
    expect(runtimeHelpers.fetchRunRuntimeRoute).not.toHaveBeenCalled();
  });

  it("proxies canonical turn diff reads to the owning runtime", async () => {
    const env = {} as Env;
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(Response.json({ diff: null }));

    await expect(operations(env).getTurnDiff({ turnId: TURN_ID })).resolves.toEqual({ diff: null });
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({ method: "GET", path: `/turn-diff?turnId=${TURN_ID}` }),
    );

    runtimeHelpers.withRunRepository.mockImplementationOnce((_env, callback) =>
      callback({ getRun: vi.fn().mockResolvedValue(null) }),
    );
    runtimeHelpers.withTurnAdmissionRepository.mockImplementationOnce(
      (_env, callback) => callback({
        getByTurnId: vi.fn().mockResolvedValue({ userId: USER_ID, runId: RUN_ID, state: "reserved" }),
      }),
    );
    await expect(operations(env).getTurnDiff({ turnId: TURN_ID })).rejects.toMatchObject({ statusCode: 404 });
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledTimes(1);

    const compactRequest = {
      runId: RUN_ID,
      sessionId: "550e8400-e29b-41d4-a716-446655440001",
      workspaceId: "wrk_123456",
      threadId: "thr_123456",
      turnId: TURN_ID,
      runAttemptId: "attempt_123456",
      backend: "cloudflare_agents" as const,
    };
    const compactResponse = {
      turnId: TURN_ID,
      accepted: true,
      status: "requested" as const,
      itemId: null,
      error: null,
    };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(Response.json(compactResponse));
    await expect(operations(env).compactTurn(compactRequest)).resolves.toEqual(compactResponse);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledWith(
      env,
      RUN_ID,
      "cloudflare_agents",
      expect.objectContaining({ method: "POST", path: "/compact", body: JSON.stringify({
        runId: RUN_ID,
        sessionId: compactRequest.sessionId,
        workspaceId: compactRequest.workspaceId,
        threadId: compactRequest.threadId,
        turnId: TURN_ID,
        runAttemptId: compactRequest.runAttemptId,
      }) }),
    );
  });

  it("proxies lifecycle approval decisions to the owning runtime", async () => {
    const env = {} as Env;
    const approval = {
      turnId: TURN_ID,
      approvalId: "appr_123456",
      decision: "approved" as const,
      grantScope: "matching_in_chat" as const,
      decidedBy: null,
      reason: null,
      backend: "cloudflare_agents" as const,
    };
    const event = {
      eventId: "evt_123456",
      threadId: "thr_123456",
      turnId: TURN_ID,
      runAttemptId: "attempt_123456",
      sequence: 1,
      idempotencyKey: "approval.decided.1",
      producer: { kind: "runtime_kernel", id: "test" },
      schemaVersion: 1,
      createdAt: "2026-10-26T00:00:00.000Z",
      itemId: "itm_123456",
      approvalId: approval.approvalId,
      type: "approval.decided",
      payload: { status: "approved", grantScope: "matching_in_chat" },
    };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(Response.json(event));

    await expect(operations(env).submitLifecycleApproval(approval)).resolves.toEqual(event);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      1,
      env,
      RUN_ID,
      "cloudflare_agents",
      expect.objectContaining({
        method: "POST",
        path: `/lifecycle-approval?turnId=${TURN_ID}&approvalId=appr_123456`,
        body: JSON.stringify({
          turnId: approval.turnId,
          approvalId: approval.approvalId,
          decision: approval.decision,
          grantScope: approval.grantScope,
          decidedBy: approval.decidedBy,
          reason: approval.reason,
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    const onceApproval = { ...approval, grantScope: "once" as const, backend: undefined };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(Response.json(event));
    await expect(operations(env).submitLifecycleApproval(onceApproval)).resolves.toEqual(event);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      2,
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({ body: JSON.stringify({ ...onceApproval, backend: undefined }) }),
    );

    const defaultApproval = { ...approval, grantScope: undefined, backend: undefined };
    runtimeHelpers.fetchRunRuntimeRoute.mockResolvedValueOnce(Response.json(event));
    await expect(operations(env).submitLifecycleApproval(defaultApproval)).resolves.toEqual(event);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenNthCalledWith(
      3,
      env,
      RUN_ID,
      "execution-engine-v1",
      expect.objectContaining({ body: JSON.stringify(defaultApproval) }),
    );

    const deniedGrant = { ...approval, decision: "denied" as const };
    await expect(operations(env).submitLifecycleApproval(deniedGrant)).rejects.toMatchObject({ statusCode: 400 });
    expect(AppServerRequestSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "turn/approval",
      params: { ...approval, grantScope: "invalid" },
    }).success).toBe(false);
    expect(runtimeHelpers.fetchRunRuntimeRoute).toHaveBeenCalledTimes(3);
  });
});
