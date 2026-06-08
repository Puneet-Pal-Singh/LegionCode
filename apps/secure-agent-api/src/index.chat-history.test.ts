import { describe, expect, it, vi } from "vitest";
vi.mock("./core/AgentRuntime", () => ({
  AgentRuntime: class AgentRuntime {},
}));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class Sandbox {},
}));
vi.mock("./runtime/LaunchRateLimiter", () => ({
  LaunchRateLimiter: class LaunchRateLimiter {},
}));

import worker, { type Env } from "./index";

describe("secure-agent-api chat history routing", () => {
  it("serves canonical history route from runId path segment", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const request = new Request(
      "https://secure.local/api/chat/history/run%2F123?cursor=cursor-1&limit=25",
      { method: "GET" },
    );

    const response = await worker.fetch(withInternalSecret(request), env);
    const body = (await response.json()) as {
      messages: Array<{ role: string; content: string }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Shadowbox-Runtime-Name")).toBe(
      "secure-agent-api-worker",
    );
    expect(runtimeStub.getHistory).toHaveBeenCalledWith(
      "run/123",
      "cursor-1",
      25,
    );
    expect(body.messages).toHaveLength(1);
  });

  it("serves runtime debug metadata", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const response = await worker.fetch(
      withInternalSecret(
        new Request("https://secure.local/api/debug/runtime", {
          method: "GET",
        }),
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Shadowbox-Runtime-Name")).toBe(
      "secure-agent-api-worker",
    );

    const body = (await response.json()) as {
      runtime: { name: string; gitSha: string };
      bindings: { agentRuntimeBound: boolean };
    };
    expect(body.runtime.name).toBe("secure-agent-api-worker");
    expect(body.runtime.gitSha).toBe("test-sha");
    expect(body.bindings.agentRuntimeBound).toBe(true);
  });

  it("keeps legacy /chat route behavior compatible", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const request = new Request(
      "https://secure.local/chat?runId=run-legacy&cursor=cursor-2&limit=10",
      { method: "GET" },
    );

    const response = await worker.fetch(withInternalSecret(request), env);
    const body = (await response.json()) as {
      messages: Array<{ role: string; content: string }>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(runtimeStub.getHistory).toHaveBeenCalledWith(
      "run-legacy",
      "cursor-2",
      10,
    );
    expect(body.messages[0]?.content).toBe("hello");
  });

  it("appends single message via canonical POST route", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const message = { role: "user", content: "test message" };
    const request = new Request(
      "https://secure.local/api/chat/history/run%2F456",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );

    const response = await worker.fetch(withInternalSecret(request), env);
    expect(response.status).toBe(200);
    expect(runtimeStub.appendMessage).toHaveBeenCalledWith(
      "run/456",
      message,
      undefined,
    );
  });

  it("appends batch messages via canonical POST route", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
    ];
    const request = new Request(
      "https://secure.local/api/chat/history/run%2F789",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      },
    );

    const response = await worker.fetch(withInternalSecret(request), env);
    expect(response.status).toBe(200);
    expect(runtimeStub.saveHistory).toHaveBeenCalledWith(
      "run/789",
      messages,
      undefined,
    );
  });

  it("forwards idempotency key in canonical POST append", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const message = { role: "user", content: "test" };
    const idempotencyKey = "idem-key-123";
    const request = new Request(
      "https://secure.local/api/chat/history/run%2Fabcd",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ message }),
      },
    );

    const response = await worker.fetch(withInternalSecret(request), env);
    expect(response.status).toBe(200);
    expect(runtimeStub.appendMessage).toHaveBeenCalledWith(
      "run/abcd",
      message,
      idempotencyKey,
    );
  });

  it("rejects canonical POST with invalid payload", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const request = withInternalSecret(
      new Request("https://secure.local/api/chat/history/run%2Fxyz", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ invalidField: "test" }),
      }),
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it("rejects chat history GET without the internal service secret", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const request = new Request(
      "https://secure.local/api/chat/history/run%2F123",
      { method: "GET" },
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    expect(runtimeStub.getHistory).not.toHaveBeenCalled();
  });

  it("rejects chat history POST without the internal service secret", async () => {
    const runtimeStub = createRuntimeStub();
    const env = createEnv(runtimeStub);
    const request = new Request(
      "https://secure.local/api/chat/history/run%2F123",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: { role: "user", content: "test" },
        }),
      },
    );

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    expect(runtimeStub.appendMessage).not.toHaveBeenCalled();
  });
});

function createRuntimeStub() {
  return {
    getHistory: vi.fn(async () => ({
      messages: [{ role: "assistant", content: "hello" }],
      nextCursor: null,
      hasMore: false,
    })),
    appendMessage: vi.fn(async () => ({ success: true })),
    saveHistory: vi.fn(async () => ({ success: true })),
  };
}

function createEnv(runtimeStub: { getHistory: unknown }): Env {
  const namespace = {
    idFromName: vi.fn(() => ({ toString: () => "stub-id" })),
    get: vi.fn(() => runtimeStub),
  };

  return {
    AGENT_RUNTIME: namespace as unknown as Env["AGENT_RUNTIME"],
    Sandbox: {} as Env["Sandbox"],
    ARTIFACTS: {} as Env["ARTIFACTS"],
    RUNTIME_GIT_SHA: "test-sha",
    INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
  };
}

const INTERNAL_RUNTIME_SECRET_HEADER = "X-Internal-Runtime-Secret";

function withInternalSecret(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_RUNTIME_SECRET_HEADER, "test-internal-secret");
  return new Request(request, { headers });
}
