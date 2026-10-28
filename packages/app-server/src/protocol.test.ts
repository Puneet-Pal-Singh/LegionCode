import { describe, expect, it } from "vitest";

import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerRequestSchema,
  AppServerResponseSchema,
} from "./protocol.js";
import { AppServerMethodOutcome, handleAppServerHttpRequest } from "./server.js";

describe("App Server protocol", () => {
  it("validates hosted session identity and rejects client-supplied tenancy", () => {
    const envelope = { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "session/create", params: {
      sessionId: "550e8400-e29b-41d4-a716-446655440001", title: "Saved task",
    } };
    expect(AppServerRequestSchema.safeParse(envelope).success).toBe(true);
    for (const params of [
      { ...envelope.params, sessionId: "thr_local123" },
      { ...envelope.params, userId: "another-user" },
      { ...envelope.params, titleSource: "user" },
      { ...envelope.params, workspaceId: "wrk_local123" },
      { ...envelope.params, runId: "550e8400-e29b-41d4-a716-446655440099" },
    ]) expect(AppServerRequestSchema.safeParse({ ...envelope, params }).success).toBe(false);
    expect(AppServerRequestSchema.safeParse({ ...envelope, method: "session/rename", params: {
      sessionId: envelope.params.sessionId, title: "x".repeat(81),
    } }).success).toBe(false);
  });

  it("validates session receipt identity and typed conflict responses", () => {
    const request = { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "session/readReceipt", params: {
      sessionId: "550e8400-e29b-41d4-a716-446655440001", terminalTurnId: "trn_terminal123",
    } };
    expect(AppServerRequestSchema.safeParse(request).success).toBe(true);
    expect(AppServerRequestSchema.safeParse({ ...request, params: { ...request.params, terminalTurnId: "550e8400-e29b-41d4-a716-446655440002" } }).success).toBe(false);
    expect(AppServerResponseSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "session/readReceipt",
      ok: false,
      error: { code: "conflict", message: "The terminal turn has changed" },
    }).success).toBe(true);
    expect(AppServerResponseSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "session/readReceipt",
      ok: true,
      result: { sessionId: request.params.sessionId, lastAcknowledgedTerminalTurnId: "trn_terminal123", acknowledgedAt: "2026-10-12T12:00:00.000Z" },
    }).success).toBe(true);
  });
  it("accepts only strict, versioned requests with canonical IDs and params", () => {
    expect(
      AppServerRequestSchema.safeParse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "thread/get",
        params: { threadId: "thr_valid123" },
      }).success,
    ).toBe(true);
    for (const request of [
      { protocolVersion: "2.0.0", method: "thread/list", params: {} },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "future/method", params: {} },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/get", params: { threadId: "bad" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", params: { extra: true } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "workspace/grant", params: { path: "/repo", selectionToken: "token" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/create", params: { title: "" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/rename", params: { threadId: "thr_valid123", title: "x".repeat(81) } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", params: {}, extra: true },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/current", params: { extra: true } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: { providerId: "OpenAI" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/select", params: { providerId: "openai", modelId: " " } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/select", params: { providerId: "openai", modelId: "gpt-4o", extra: true } },
    ]) {
      expect(AppServerRequestSchema.safeParse(request).success).toBe(false);
    }

    const interrupt = {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "turn/interrupt",
      params: {
        runId: "run_123e4567e89b42d3a456426614174100",
        workspaceId: "123e4567-e89b-42d3-a456-426614174111",
        sessionId: "session-123456",
        threadId: "thr_123456",
        turnId: "trn_123456",
        runAttemptId: "attempt_123456",
        reason: "User stopped the turn.",
      },
    };
    expect(AppServerRequestSchema.safeParse(interrupt).success).toBe(true);
    expect(AppServerRequestSchema.safeParse({
      ...interrupt,
      params: { ...interrupt.params, orchestratorBackend: "cloudflare_agents" },
    }).success).toBe(true);
    expect(AppServerRequestSchema.safeParse({
      ...interrupt,
      params: { ...interrupt.params, userId: "another-user" },
    }).success).toBe(false);

    const threadScope = {
      threadId: "thr_123456",
      workspaceId: "123e4567-e89b-42d3-a456-426614174111",
    };
    const threadInputCommands = [
      { method: "turn/steer", params: { ...threadScope, operation: "turn.steer", clientInputId: "input-1", expectedTurnId: "trn_123456", expectedRunAttemptId: "attempt_123456", content: { text: "hello", images: [] } } },
      { method: "turn/resume", params: { ...threadScope, operation: "turn.resume", clientCommandId: "command-1", expectedTurnId: "trn_123456", expectedRunAttemptId: "attempt_123456", expectedTerminalSequence: 1 } },
      { method: "thread/input/enqueue", params: { ...threadScope, operation: "thread.input.enqueue", clientInputId: "input-1", content: { text: "hello", images: [] }, configuration: {} } },
      { method: "thread/input/list", params: { ...threadScope, operation: "thread.input.list" } },
      { method: "thread/input/update", params: { ...threadScope, operation: "thread.input.update", itemId: "123e4567-e89b-42d3-a456-426614174222", expectedVersion: 1, content: { text: "hello" } } },
      { method: "thread/input/remove", params: { ...threadScope, operation: "thread.input.remove", itemId: "123e4567-e89b-42d3-a456-426614174222", expectedVersion: 1 } },
      { method: "thread/input/steer", params: { ...threadScope, operation: "thread.input.steer", itemId: "123e4567-e89b-42d3-a456-426614174222", expectedVersion: 1, expectedTurnId: "trn_123456", expectedRunAttemptId: "attempt_123456" } },
      { method: "thread/input/start", params: { ...threadScope, operation: "thread.input.start", itemId: "123e4567-e89b-42d3-a456-426614174222", expectedVersion: 1, expectedThreadRevision: 1 } },
    ];
    for (const command of threadInputCommands) {
      expect(AppServerRequestSchema.safeParse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        ...command,
      }).success).toBe(true);
    }
  });

  it("preserves UUID session scope and pinned history validation without local Thread IDs", () => {
    const request = { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "session/history", params: { session: "550e8400-e29b-41d4-a716-446655440001", limit: 50 } };
    expect(AppServerRequestSchema.safeParse(request).success).toBe(true);
    for (const params of [
      { session: "thr_local123" },
      { ...request.params, userId: "another-user" },
      { ...request.params, cursor: "1" },
      { ...request.params, cursor: "2", snapshot: "1" },
    ]) {
      expect(AppServerRequestSchema.safeParse({ ...request, params }).success).toBe(false);
    }
    expect(AppServerResponseSchema.safeParse({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "session/history", ok: true, result: { messages: [], nextCursor: null, snapshot: "0" } }).success).toBe(true);
  });

  it("validates strict success and failure response envelopes", async () => {
    expect(
      AppServerResponseSchema.safeParse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "workspace/revoke",
        ok: true,
        result: { revoked: true },
      }).success,
    ).toBe(true);
    expect(AppServerResponseSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "turn/interrupt",
      ok: true,
      result: {
        runId: "run_123456",
        accepted: true,
        status: "interrupt_requested",
      },
    }).success).toBe(true);
    expect(AppServerResponseSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "thread/input/enqueue",
      ok: true,
      result: { status: "conflict", code: "queue_item_changed", message: "Queue item changed" },
    }).success).toBe(true);
    expect(AppServerResponseSchema.safeParse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "thread/input/enqueue",
      ok: false,
      error: { code: "conflict", message: "Queue item changed", statusCode: 409, operationCode: "queue_item_changed", metadata: { source: "queue" } },
    }).success).toBe(true);
    for (const response of [
      { protocolVersion: "9.0.0", method: "workspace/revoke", ok: true, result: { revoked: true } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: true, result: { threads: [], extra: 1 } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "unknown", ok: false, error: { code: "invalid_request", message: "bad" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: false, error: { code: "invalid_request", message: "bad", detail: "extra" } },
    ]) {
      expect(AppServerResponseSchema.safeParse(response).success).toBe(false);
    }

    let inputCall = 0;
    const inputRequest = {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "thread/input/enqueue",
      params: {
        operation: "thread.input.enqueue",
        threadId: "thr_123456",
        workspaceId: "123e4567-e89b-42d3-a456-426614174111",
        clientInputId: "input-1",
        content: { text: "hello", images: [] },
        configuration: {},
      },
    };
    const dispatchInput = () => handleAppServerHttpRequest({
      method: "POST",
      path: "/app-server/request",
      contentType: "application/json",
      rawBody: JSON.stringify(inputRequest),
    }, {
      environment: "hosted",
      serverId: "test",
      serverVersion: "test",
      hostedThreadInputOperationsService: {
        execute: async () => {
          inputCall += 1;
          return inputCall === 1
            ? new AppServerMethodOutcome(201, {
                status: "pending", clientInputId: "input-1",
                itemId: "123e4567-e89b-42d3-a456-426614174222",
                order: 1, version: 1, revision: 1,
              })
            : new AppServerMethodOutcome(409, {
                status: "conflict", code: "queue_item_changed", message: "Queue item changed",
              });
        },
      },
    });
    await expect(dispatchInput()).resolves.toMatchObject({
      statusCode: 201,
      payload: { method: "thread/input/enqueue", ok: true, result: { status: "pending" } },
    });
    await expect(dispatchInput()).resolves.toMatchObject({
      statusCode: 409,
      payload: { method: "thread/input/enqueue", ok: true, result: { status: "conflict" } },
    });
  });
});
