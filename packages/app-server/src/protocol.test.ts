import { describe, expect, it } from "vitest";

import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerRequestSchema,
  AppServerResponseSchema,
} from "./protocol.js";

describe("App Server protocol", () => {
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
  });

  it("validates strict success and failure response envelopes", () => {
    expect(
      AppServerResponseSchema.safeParse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "workspace/revoke",
        ok: true,
        result: { revoked: true },
      }).success,
    ).toBe(true);
    for (const response of [
      { protocolVersion: "9.0.0", method: "workspace/revoke", ok: true, result: { revoked: true } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: true, result: { threads: [], extra: 1 } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "unknown", ok: false, error: { code: "invalid_request", message: "bad" } },
      { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: false, error: { code: "invalid_request", message: "bad", detail: "extra" } },
    ]) {
      expect(AppServerResponseSchema.safeParse(response).success).toBe(false);
    }
  });
});
