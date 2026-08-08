import { describe, expect, it } from "vitest";
import { parseChatRequestBody } from "../chat-request";

describe("parseChatRequestBody", () => {
  it("accepts a complete outbound chat request body", () => {
    expect(
      parseChatRequestBody({
        sessionId: "session-1",
        runId: "run-1",
        identity: {
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: "thr_test-1",
          turnId: "trn_test-1",
          runAttemptId: "attempt_test-1",
        },
        clientMessageId: "client_msg_1",
        mode: "build",
        productMode: "full_agent",
        providerId: "axis",
        modelId: "model-a",
        harnessId: "cloudflare-sandbox",
        repositoryOwner: "owner",
        repositoryName: "repo",
        repositoryBranch: "main",
        repositoryBaseUrl: "https://github.com/owner/repo",
        reasoningEffort: "high",
      }),
    ).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      clientMessageId: "client_msg_1",
      repositoryBaseUrl: "https://github.com/owner/repo",
      reasoningEffort: "high",
    });
  });

  it("rejects malformed outbound request bodies", () => {
    expect(() =>
      parseChatRequestBody({
        sessionId: "",
        runId: "run-1",
        identity: {
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: "thr_test-1",
          turnId: "trn_test-1",
          runAttemptId: "attempt_test-1",
        },
        repositoryBaseUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects runtime-owned context and pricing metadata", () => {
    expect(() =>
      parseChatRequestBody({
        sessionId: "session-1",
        runId: "run-1",
        identity: {
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: "thr_test-1",
          turnId: "trn_test-1",
          runAttemptId: "attempt_test-1",
        },
        contextWindowTokens: 1,
        pricing: { inputPer1M: 0, outputPer1M: 0 },
      } as never),
    ).toThrow();
  });
});
