import { describe, expect, it, vi } from "vitest";
import { CodingAgent } from "./CodingAgent";
import type { ILLMGateway } from "../llm";
import type { RuntimeExecutionService, ExecutionContext } from "../types";
import type { Task } from "../task";

describe("CodingAgent task-phase model selection", () => {
  it("returns a guarded synthesis message when mutation was requested but no edit completed", async () => {
    const llmGateway = createLLMGatewayMock();
    const executionService = createExecutionServiceMock();
    const agent = new CodingAgent(llmGateway, executionService);

    const synthesis = await agent.synthesize({
      runId: "run-1",
      sessionId: "session-1",
      originalPrompt: "add logging to PendingJobCard.tsx",
      completedTasks: [
        {
          id: "task-read-1",
          runId: "run-1",
          type: "analyze",
          status: "DONE",
          dependencies: [],
          input: { description: "Read PendingJobCard.tsx", path: "PendingJobCard.tsx" },
          output: { content: "Read file successfully" },
          retryCount: 0,
          maxRetries: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      modelId: "gpt-4o",
      providerId: "openai",
    });

    expect(synthesis).toContain("I'm not done with that change yet.");
    expect(synthesis).toContain("did not record any successful edit/write task");
    expect(llmGateway.generateText).not.toHaveBeenCalled();
  });

  it("falls back to grounded summary when synthesis returns raw tool transcript markup", async () => {
    const llmGateway = createLLMGatewayMock({
      generateText: vi.fn(async () => ({
        text: "<tool_call><parameters>bad transcript</parameters></tool_call>",
      })),
    });
    const executionService = createExecutionServiceMock();
    const agent = new CodingAgent(llmGateway, executionService);

    const synthesis = await agent.synthesize({
      runId: "run-1",
      sessionId: "session-1",
      originalPrompt: "make the landing page more beautiful",
      completedTasks: [
        {
          id: "task-write-1",
          runId: "run-1",
          type: "write_file",
          status: "DONE",
          dependencies: [],
          input: { description: "Update landing page", path: "src/app/page.tsx" },
          output: {
            content: "Wrote 100 bytes to src/app/page.tsx",
            metadata: {
              activity: {
                family: "edit",
                filePath: "src/app/page.tsx",
                additions: 30,
                deletions: 16,
              },
            },
          },
          retryCount: 0,
          maxRetries: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      modelId: "gpt-4o",
      providerId: "openai",
    });

    expect(synthesis).toContain("updated src/app/page.tsx (+30 -16)");
    expect(synthesis).not.toContain("<tool_call>");
  });

  it("passes model/provider overrides to review task LLM calls", async () => {
    const llmGateway = createLLMGatewayMock();
    const executionService = createExecutionServiceMock();
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-review-1",
      runId: "run-1",
      type: "review",
      input: { description: "Review this change" },
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

  it("returns FAILED when filesystem read returns plugin failure", async () => {
    const llmGateway = createLLMGatewayMock();
    const executionService = {
      execute: vi.fn(async () => ({
        success: false,
        error: "cat: README.md: No such file or directory",
      })),
    } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-analyze-1",
      runId: "run-1",
      type: "analyze",
      input: { description: "Check README", path: "README.md" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("No such file or directory");
  });

  it("normalizes @readme path aliases before analyze execution", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({ success: true, output: "ok" }));
    const executionService = {
      execute,
    } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-analyze-2",
      runId: "run-1",
      type: "analyze",
      input: { description: "check @readme", path: "@readme" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalledWith("filesystem", "read_file", {
      path: "README.md",
    });
  });

  it("routes ls shell commands to filesystem list_files", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({ success: true, output: "README.md" }));
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-shell-ls",
      runId: "run-1",
      type: "shell",
      input: { description: "list files", command: "ls -la src" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalledWith("filesystem", "list_files", {
      path: "src",
    });
  });

  it("fails fast on git shell commands", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => "ok");
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-shell-git",
      runId: "run-1",
      type: "shell",
      input: { description: "inspect repo", command: "git status" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalled();
  });

  it("routes golden-flow read_file tool calls through the gateway contract", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({
      success: true,
      output: "README body",
    }));
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-tool-read",
      runId: "run-1",
      type: "read_file",
      input: { description: "read file", path: "README.md" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalledWith("filesystem", "read_file", {
      path: "README.md",
    });
  });

  it("routes bash and git_diff tools to bounded executable handlers", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: "ok" })
      .mockResolvedValueOnce({
        success: true,
        output: "diff --git a/a.ts b/a.ts",
      });
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const commandTask = {
      id: "task-tool-command",
      runId: "run-1",
      type: "bash",
      input: { description: "run tests", command: "pnpm test" },
    } as unknown as Task;
    const commandResult = await agent.executeTask(commandTask, context);
    expect(commandResult.status).toBe("DONE");

    const diffTask = {
      id: "task-tool-diff",
      runId: "run-1",
      type: "git_diff",
      input: { description: "show diff" },
    } as unknown as Task;
    const diffResult = await agent.executeTask(diffTask, context);
    expect(diffResult.status).toBe("DONE");

    expect(execute).toHaveBeenCalledWith("bash", "run", {
      command: "pnpm test",
    });
    expect(execute).toHaveBeenCalledWith("git", "git_diff", {});
  });

  it("normalizes embedded local-machine cd prefixes before running bash tools", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({ success: true, output: "ok" }));
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const task = {
      id: "task-tool-bash-cd",
      runId: "run-1",
      type: "bash",
      input: {
        description: "lint files",
        command:
          "cd /home/user/repos/career-crew && npx next lint --file src/app/page.tsx",
      },
    } as unknown as Task;

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("DONE");
    expect(execute).toHaveBeenCalledWith("bash", "run", {
      command: "npx next lint --file src/app/page.tsx",
      cwd: undefined,
    });
  });

  it("preserves edit activity metadata for write_file results", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: "old line\n" })
      .mockResolvedValueOnce({
        success: true,
        output: "Wrote 8 bytes to notes.txt",
      });
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-tool-write",
      runId: "run-1",
      type: "write_file",
      input: {
        description: "write file",
        path: "notes.txt",
        content: "new line\n",
      },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("DONE");
    expect(result.output?.metadata).toMatchObject({
      activity: expect.objectContaining({
        family: "edit",
        filePath: "notes.txt",
        additions: 1,
        deletions: 1,
      }),
    });
  });

  it("uses discovery-first analyze flow for ambiguous targets", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({
      success: true,
      output: "README.md\nsrc/\n",
    }));
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-analyze-discovery",
      runId: "run-1",
      type: "analyze",
      input: { description: "check this file", path: "this file" },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);
    expect(result.status).toBe("DONE");
    expect(result.output?.content).toContain("Running discovery first");
    expect(execute).toHaveBeenCalledWith("filesystem", "list_files", {
      path: ".",
    });
  });

  it("surfaces gateway failures during grep discovery", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(
      async (
        plugin: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        if (plugin === "filesystem" && action === "list_files") {
          return { success: true, output: "README.md\n" };
        }
        if (
          plugin === "filesystem" &&
          action === "read_file" &&
          payload.path === "README.md"
        ) {
          return { success: true, output: "aaaa\nbbbb\n" };
        }
        return { success: false, error: `unexpected call ${plugin}:${action}` };
      },
    );
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-grep-unsafe-pattern",
      runId: "run-1",
      type: "grep",
      input: {
        description: "grep",
        pattern: "(a+)+$",
        path: ".",
        caseSensitive: true,
      },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    const result = await agent.executeTask(task, context);

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain(
      "unexpected call filesystem:grep",
    );
  });

  it("rejects invalid grep input types via golden-flow schema validation", async () => {
    const llmGateway = createLLMGatewayMock();
    const execute = vi.fn(async () => ({
      success: true,
      output: "README.md\n",
    }));
    const executionService = { execute } as unknown as RuntimeExecutionService;
    const agent = new CodingAgent(llmGateway, executionService);

    const task = {
      id: "task-grep-invalid-input",
      runId: "run-1",
      type: "grep",
      input: {
        description: "grep",
        pattern: "TODO",
        caseSensitive: "true",
      },
    } as unknown as Task;

    const context: ExecutionContext = {
      runId: "run-1",
      sessionId: "session-1",
      dependencies: [],
    };

    await expect(agent.executeTask(task, context)).rejects.toThrow(
      "Invalid grep input",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

function createLLMGatewayMock(
  overrides?: Partial<ILLMGateway>,
): ILLMGateway {
  return {
    generateText: vi.fn(async () => ({
      text: "reviewed",
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
    ...overrides,
  } as unknown as ILLMGateway;
}

function createExecutionServiceMock(): RuntimeExecutionService {
  return {
    execute: vi.fn(async () => "ok"),
  };
}
