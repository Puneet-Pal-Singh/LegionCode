import { describe, expect, it, vi } from "vitest";
import { ReviewAgent } from "./ReviewAgent";
import type { ILLMGateway } from "../llm";
import type { RuntimeExecutionService, ExecutionContext } from "../types";
import type { Task } from "../task";

describe("ReviewAgent task-phase model selection", () => {
  it("passes model/provider overrides to analyze task LLM calls", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => "file contents");
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new ReviewAgent(llmGateway, executionService);

    const task = {
      id: "task-analyze-1",
      runId: "run-1",
      type: "analyze",
      input: { description: "src/index.ts", path: "src/index.ts" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
      modelId: "gpt-4o-mini",
      providerId: "openai",
    };

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalledWith("filesystem", "read_file", {
      path: "src/index.ts",
    });
    expect(llmGateway.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        providerId: "openai",
      }),
    );
  });

  it("passes model/provider overrides to review task LLM calls", async () => {
    const llmGateway = createLLMGatewayMock();
    const executionService = createExecutionServiceMock("unused");
    const agent = new ReviewAgent(llmGateway, executionService);

    const task = {
      id: "task-review-2",
      runId: "run-1",
      type: "review",
      input: { description: "review this patch" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
      modelId: "gpt-4o",
      providerId: "openai",
    };

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("DONE");
    expect(llmGateway.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        providerId: "openai",
      }),
    );
  });

  it("returns FAILED when analyze file read fails", async () => {
    const llmGateway = createLLMGatewayMock();
    const executionService = {
      execute: vi.fn(async () => ({
        success: false,
        error: "cat: src/missing.ts: No such file or directory",
      })),
    } as unknown as RuntimeExecutionService;
    const agent = new ReviewAgent(llmGateway, executionService);

    const task = {
      id: "task-analyze-fail",
      runId: "run-1",
      type: "analyze",
      input: { description: "src/missing.ts", path: "src/missing.ts" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
      modelId: "gpt-4o",
      providerId: "openai",
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("No such file or directory");
  });
});

function createLLMGatewayMock(): ILLMGateway {
  return {
    generateText: vi.fn(async () => ({
      text: "reviewed",
      parts: [
        {
          id: "test-review-part",
          schemaVersion: 1 as const,
          runId: "run-1",
          turnId: "run-1",
          sequence: 0,
          createdAt: "2026-07-10T00:00:00.000Z",
          type: "visible_text" as const,
          visibility: "visible" as const,
          text: "reviewed",
          finalized: false,
        },
      ],
      usage: {
        provider: "openai",
        model: "gpt-4o",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    })),
    generateStructured: vi.fn(),
    generateStream: vi.fn(),
  } as unknown as ILLMGateway;
}

function createExecutionServiceMock(content: string): RuntimeExecutionService {
  return {
    execute: vi.fn(async () => content),
  };
}
