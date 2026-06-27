import { describe, expect, it } from "vitest";
import { ExecuteRunPayloadSchema } from "./ExecuteRunPayloadSchema";

function createValidPayload() {
  return {
    runId: "run_100001",
    sessionId: "session-1",
    correlationId: "corr-1",
    input: {
      mode: "build" as const,
      agentType: "coding" as const,
      prompt: "inspect repository",
      sessionId: "session-1",
      orchestratorBackend: "execution-engine-v1" as const,
      executionBackend: "cloudflare_sandbox" as const,
      harnessMode: "platform_owned" as const,
      authMode: "api_key" as const,
    },
    messages: [{ role: "user", content: "inspect repository" }],
  };
}

describe("ExecuteRunPayloadSchema tools validation", () => {
  it("rejects non-canonical run ids", () => {
    const payload = createValidPayload();
    payload.runId = "123e4567-e89b-42d3-a456-426614174000";

    const result = ExecuteRunPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects primitive tool schema values in inputSchema/parameters", () => {
    const payload = createValidPayload();
    payload.tools = {
      bash: {
        description: "Run shell command",
        inputSchema: "not-an-object",
        parameters: 42,
      },
    };

    const result = ExecuteRunPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("applies default empty parameters object when omitted", () => {
    const payload = createValidPayload();
    payload.tools = {
      bash: {
        description: "Run shell command",
        inputSchema: { type: "object" },
      },
    };

    const result = ExecuteRunPayloadSchema.parse(payload);
    expect(result.tools?.bash?.parameters).toEqual({});
  });

  it("accepts object parameters for tool definitions", () => {
    const payload = createValidPayload();
    payload.tools = {
      bash: {
        description: "Run shell command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
        },
      },
    };

    const result = ExecuteRunPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("keeps validated input.metadata feature flags", () => {
    const payload = createValidPayload();
    payload.input.metadata = {
      featureFlags: {
        agenticLoopV1: true,
        reviewerPassV1: false,
        ghCliLaneEnabled: true,
        ghCliCiEnabled: true,
        ghCliPrCommentEnabled: false,
      },
    };

    const result = ExecuteRunPayloadSchema.parse(payload);
    expect(result.input.metadata?.featureFlags?.agenticLoopV1).toBe(true);
    expect(result.input.metadata?.featureFlags?.reviewerPassV1).toBe(false);
    expect(result.input.metadata?.featureFlags?.ghCliLaneEnabled).toBe(true);
    expect(result.input.metadata?.featureFlags?.ghCliCiEnabled).toBe(true);
    expect(result.input.metadata?.featureFlags?.ghCliPrCommentEnabled).toBe(
      false,
    );
  });

  it("accepts explicit plan mode", () => {
    const payload = createValidPayload();
    payload.input.mode = "plan";

    const result = ExecuteRunPayloadSchema.parse(payload);
    expect(result.input.mode).toBe("plan");
  });

  it("preserves client message ids for activity turn correlation", () => {
    const payload = createValidPayload();
    payload.messages = [
      { id: "client-user-1", role: "user", content: "inspect repository" },
    ];

    const result = ExecuteRunPayloadSchema.parse(payload);
    expect(result.messages[0]?.id).toBe("client-user-1");
  });

  it("accepts provider/model overrides without repository context", () => {
    const payload = createValidPayload();
    payload.input.providerId = "gemini";
    payload.input.modelId = "gemma-3-27b-it";

    const result = ExecuteRunPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("still enforces provider/model pair semantics", () => {
    const payload = createValidPayload();
    payload.input.providerId = "gemini";

    const result = ExecuteRunPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
