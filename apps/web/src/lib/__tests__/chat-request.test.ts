import { describe, expect, it } from "vitest";
import { parseChatRequestBody } from "../chat-request";

describe("parseChatRequestBody", () => {
  it("accepts a complete outbound chat request body", () => {
    expect(
      parseChatRequestBody({
        sessionId: "session-1",
        runId: "run-1",
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
      }),
    ).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      clientMessageId: "client_msg_1",
      repositoryBaseUrl: "https://github.com/owner/repo",
    });
  });

  it("rejects malformed outbound request bodies", () => {
    expect(() =>
      parseChatRequestBody({
        sessionId: "",
        runId: "run-1",
        repositoryBaseUrl: "not-a-url",
      }),
    ).toThrow();
  });
});
