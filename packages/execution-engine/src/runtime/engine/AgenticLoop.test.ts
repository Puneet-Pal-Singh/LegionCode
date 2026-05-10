import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../cost/index.js";
import type { ILLMGateway } from "../llm/index.js";
import { LLMUnusableResponseError } from "../llm/index.js";
import type { IBudgetManager } from "../cost/index.js";
import type { TaskExecutor } from "../orchestration/index.js";
import { AgenticLoop, type AgenticLoopConfig } from "./AgenticLoop.js";

describe("AgenticLoop - Bounded Agentic Tool Chaining", () => {
  let config: AgenticLoopConfig;
  let llmGateway: Partial<ILLMGateway>;
  let executor: Partial<TaskExecutor>;
  let budgetManager: Partial<IBudgetManager>;
  let loop: AgenticLoop;

  beforeEach(() => {
    config = {
      maxSteps: 5,
      runId: "run-123",
      sessionId: "session-123",
    };

    llmGateway = {
      generateText: vi.fn(),
    };

    executor = {
      execute: vi.fn(),
    };

    budgetManager = {
      isOverBudget: vi.fn().mockResolvedValue(false),
    };

    config.budget = budgetManager as IBudgetManager;
    loop = new AgenticLoop(
      config,
      llmGateway as ILLMGateway,
      executor as TaskExecutor,
    );
  });

  describe("Configuration", () => {
    it("should reject maxSteps < 1", () => {
      expect(() => {
        new AgenticLoop(
          { maxSteps: 0, runId: "run-1", sessionId: "session-1" },
          llmGateway as ILLMGateway,
          executor as TaskExecutor,
        );
      }).toThrow("maxSteps must be >= 1");
    });

    it("should accept valid configuration", () => {
      expect(loop).toBeDefined();
    });
  });

  describe("Stop Reasons", () => {
    it("should stop with llm_stop when LLM doesn't request tools", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      const result = await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.stepsExecuted).toBe(1);
    });

    it("keeps CI inspection read-only even when earlier turns asked for mutation", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "CI checks are currently green.",
        usage: { promptTokens: 11, completionTokens: 6 },
      });

      const result = await loop.execute(
        [
          { role: "user", content: "edit the footer and push it" },
          { role: "assistant", content: "I can do that." },
          { role: "user", content: "check CI checks passed or not" },
        ],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.requiresMutation).toBe(false);
      expect(result.currentTurnIntent).toBe("read_only");
    });

    it("stops neutrally when an edit request ends without a mutating tool", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "I'll inspect the target first.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "src/app.tsx" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Done.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "export default function App() {}" },
        completedAt: new Date(),
      });

      const result = await loop.execute(
        [{ role: "user", content: "update my footer copy" }],
        {
          read_file: {
            description: "Read a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.completedMutatingToolCount).toBe(0);
      expect(result.completedReadOnlyToolCount).toBe(1);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(2);
      const finalRequest = vi.mocked(llmGateway.generateText).mock
        .calls[1]?.[0] as {
        system?: string;
      };
      expect(finalRequest.system).not.toContain("Corrective retry:");
    });

    it("does not run a corrective retry after a no-tool edit response", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValueOnce({
        text: "I think I'm done.",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      vi.mocked(budgetManager.isOverBudget!)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await loop.execute(
        [{ role: "user", content: "edit the footer" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(llmGateway.generateText).toHaveBeenCalledTimes(1);
    });

    it("retries once when the provider returns an unusable response", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockRejectedValueOnce(
          new LLMUnusableResponseError({
            providerId: "google",
            modelId: "gemini-2.5-flash-lite",
            anomalyCode: "EMPTY_CANDIDATE",
            finishReason: "stop",
            statusCode: 200,
          }),
        )
        .mockResolvedValueOnce({
          text: "Done",
          toolCalls: [],
          finishReason: "stop",
          usage: {
            provider: "google",
            model: "gemini-2.5-flash-lite",
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        });

      const result = await loop.execute(
        [{ role: "user", content: "inspect the repository" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.llmRetryCount).toBe(1);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(2);
    });

    it("should stop with budget_exceeded when budget is over", async () => {
      vi.mocked(budgetManager.isOverBudget!).mockResolvedValue(true);

      const result = await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("budget_exceeded");
    });

    it("should stop with budget_exceeded when BudgetExceededError thrown", async () => {
      vi.mocked(budgetManager.isOverBudget!).mockRejectedValue(
        new BudgetExceededError("run-123", 1.5, 1.0),
      );

      const result = await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("budget_exceeded");
    });

    it("stops quickly when the run is cancelled between steps", async () => {
      const isRunCancelled = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Inspecting the page.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "src/app/page.tsx" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "This call should never happen.",
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 5 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "export default function Page() {}" },
        completedAt: new Date(),
      });

      const result = await loop.execute(
        [{ role: "user", content: "update the hero section" }],
        {
          read_file: {
            description: "Read a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        {
          agentType: "coding",
          isRunCancelled,
        },
      );

      expect(result.stopReason).toBe("cancelled");
      expect(llmGateway.generateText).toHaveBeenCalledTimes(1);
      expect(executor.execute).toHaveBeenCalledTimes(0);
    });
  });

  describe("Message Handling", () => {
    it("should add LLM response to message history", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Response text",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      const initialMessages = [{ role: "user" as const, content: "test" }];
      const result = await loop.execute(
        initialMessages,
        {},
        { agentType: "coding" },
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual(initialMessages[0]);
      expect(result.messages[1]).toEqual({
        role: "assistant",
        content: "Response text",
      });
    });

    it("emits assistant commentary only when the model is about to call tools", async () => {
      const onAssistantMessage = vi.fn();
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "I found the footer file and will read it now.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "src/components/Footer.tsx" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Done.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "footer content" },
        completedAt: new Date(),
      });

      await loop.execute(
        [{ role: "user", content: "inspect the footer" }],
        {
          read_file: {
            description: "Read a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        {
          agentType: "coding",
          onAssistantMessage,
        },
      );

      expect(onAssistantMessage).toHaveBeenCalledTimes(1);
      expect(onAssistantMessage).toHaveBeenCalledWith(
        "I found the footer file and will read it now.",
      );
    });

    it("executes tool calls and appends tool results for next LLM step", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Calling tool",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "README.md" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Tool result processed",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "README content" },
        completedAt: new Date(),
      });

      const tools = {
        read_file: {
          description: "Read a file",
        },
      } as unknown as Record<string, import("ai").CoreTool>;

      const result = await loop.execute(
        [{ role: "user", content: "read readme" }],
        tools,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.stepsExecuted).toBe(2);
      expect(result.toolExecutionCount).toBe(1);
      expect(result.failedToolCount).toBe(0);
      expect(result.toolLifecycle.map((event) => event.status)).toEqual([
        "requested",
        "started",
        "completed",
      ]);
      expect(result.toolLifecycle[2]).toMatchObject({
        toolName: "read_file",
        mutating: false,
      });
      expect(result.messages).toHaveLength(4);
      expect(result.messages[1]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool" },
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        ],
      });
      expect(result.messages[2]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "read_file",
            result: { content: "README content" },
            isError: false,
          },
        ],
      });
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    it("skips repeated identical read-only tool calls after one successful result", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "I'll list the target folder.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "list_files",
              args: { path: "src/components/landing" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "I'll retry the same listing.",
          toolCalls: [
            {
              id: "tool-call-2",
              toolName: "list_files",
              args: { path: "src/components/landing" },
            },
          ],
          usage: { promptTokens: 12, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Done.",
          toolCalls: [],
          usage: { promptTokens: 14, completionTokens: 7 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "Hero.tsx\nFooter.tsx" },
        completedAt: new Date(),
      });

      const onToolFailed = vi.fn(async () => undefined);
      const result = await loop.execute(
        [{ role: "user", content: "update the landing page CTA" }],
        {
          list_files: {
            description: "List files",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        {
          agentType: "coding",
          onToolFailed,
        },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(onToolFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: "tool-call-2", toolName: "list_files" }),
        expect.stringContaining("Skipped duplicate list_files call"),
        0,
      );
    });

    it("injects workspace context into the task-phase system prompt", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      await loop.execute(
        [{ role: "user", content: "check my landing page" }],
        {},
        {
          agentType: "coding",
          workspaceContext: "Repository: acme/career-crew\nBranch: main",
        },
      );

      expect(llmGateway.generateText).toHaveBeenCalledTimes(1);
      const firstRequest = vi.mocked(llmGateway.generateText).mock
        .calls[0]?.[0] as {
        system?: string;
      };
      expect(firstRequest.system).toContain("Repository: acme/career-crew");
      expect(firstRequest.system).toContain("Branch: main");
    });

    it("adds CI log guardrails when the latest user turn asks for CI logs", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      await loop.execute(
        [{ role: "user", content: "fetch CI checks logs again and debug it" }],
        {},
        {
          agentType: "coding",
        },
      );

      expect(llmGateway.generateText).toHaveBeenCalledTimes(1);
      const firstRequest = vi.mocked(llmGateway.generateText).mock
        .calls[0]?.[0] as {
        system?: string;
      };
      expect(firstRequest.system).toContain("CI logs request rule:");
      expect(firstRequest.system).toContain(
        "Do not run or suggest local lint/test commands as a fallback unless the user explicitly asks for a local fallback.",
      );
    });

    it("passes execution timing to tool lifecycle hooks", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Calling tool",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "README.md" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Done",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "README content" },
        completedAt: new Date(),
      });

      const onToolCompleted = vi.fn(async () => undefined);
      const tools = {
        read_file: {
          description: "Read a file",
        },
      } as unknown as Record<string, import("ai").CoreTool>;

      await loop.execute([{ role: "user", content: "read readme" }], tools, {
        agentType: "coding",
        onToolCompleted,
      });

      expect(onToolCompleted).toHaveBeenCalledTimes(1);
      expect(onToolCompleted.mock.calls[0]?.[2]).toEqual(expect.any(Number));
    });

    it("can execute tools directly without routing through the task executor", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Checking git status.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "git_status",
              args: {},
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Your branch is main and the working tree is clean.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockRejectedValue(
        new Error("task executor should be bypassed"),
      );

      const executeTool = vi.fn(async () => ({
        taskId: "tool-call-1",
        status: "DONE" as const,
        output: {
          content:
            '{"files":[],"ahead":0,"behind":0,"branch":"main","hasStaged":false,"hasUnstaged":false}',
        },
        completedAt: new Date(),
      }));

      const result = await loop.execute(
        [{ role: "user", content: "check my git info" }],
        {
          git_status: {
            description: "Inspect git status",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        {
          agentType: "coding",
          executeTool,
        },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(executeTool).toHaveBeenCalledWith({
        id: "tool-call-1",
        toolName: "git_status",
        args: {},
      });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("preserves structured edit metadata on completed mutating tool lifecycle events", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Updating the job detail page.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "write_file",
              args: {
                path: "src/components/jobs/JobDetailView.tsx",
                content: "<section>updated</section>",
              },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "Done.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: {
          content: "Updated src/components/jobs/JobDetailView.tsx",
          metadata: {
            activity: {
              family: "edit",
              filePath: "src/components/jobs/JobDetailView.tsx",
              additions: 14,
              deletions: 3,
            },
          },
        },
        completedAt: new Date(),
      });

      const result = await loop.execute(
        [{ role: "user", content: "update my job detail page" }],
        {
          write_file: {
            description: "Write a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        { agentType: "coding" },
      );

      expect(result.completedMutatingToolCount).toBe(1);
      expect(result.toolLifecycle[2]).toMatchObject({
        toolName: "write_file",
        status: "completed",
        metadata: {
          family: "edit",
          filePath: "src/components/jobs/JobDetailView.tsx",
          additions: 14,
          deletions: 3,
        },
      });
    });

    it("stops with tool_error when LLM requests an unregistered tool", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "calling unknown tool",
        toolCalls: [
          {
            id: "unknown-call",
            toolName: "delete_all",
            args: {},
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      const result = await loop.execute(
        [{ role: "user", content: "do something risky" }],
        {},
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("tool_error");
      expect(result.toolExecutionCount).toBe(1);
      expect(result.failedToolCount).toBe(1);
      expect(result.toolLifecycle.map((event) => event.status)).toEqual([
        "requested",
        "failed",
      ]);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("continues after a non-mutating tool failure so the model can recover", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Trying to read middleware directly first.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "middleware.ts" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "I'll search more broadly instead.",
          toolCalls: [
            {
              id: "tool-call-2",
              toolName: "grep",
              args: { pattern: "middleware", path: "." },
            },
          ],
          usage: { promptTokens: 12, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "I found the middleware entrypoint.",
          toolCalls: [],
          usage: { promptTokens: 14, completionTokens: 7 },
        });

      vi.mocked(executor.execute!)
        .mockResolvedValueOnce({
          taskId: "tool-call-1",
          status: "FAILED",
          error: {
            message:
              "The requested file was not found in the current workspace.",
          },
          completedAt: new Date(),
        })
        .mockResolvedValueOnce({
          taskId: "tool-call-2",
          status: "DONE",
          output: {
            content: "src/middleware.ts:1: export function middleware()",
          },
          completedAt: new Date(),
        });

      const tools = {
        read_file: {
          description: "Read a file",
        },
        grep: {
          description: "Search file contents",
        },
      } as unknown as Record<string, import("ai").CoreTool>;

      const result = await loop.execute(
        [{ role: "user", content: "check my middleware" }],
        tools,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.stepsExecuted).toBe(3);
      expect(result.toolExecutionCount).toBe(2);
      expect(result.failedToolCount).toBe(1);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(3);
      expect(result.toolLifecycle.map((event) => event.status)).toEqual([
        "requested",
        "started",
        "failed",
        "requested",
        "started",
        "completed",
      ]);
    });

    it("continues after a recoverable git_branch_switch failure so the model can recover", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Switching to the PR head branch first.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "git_branch_switch",
              args: { branch: "style/redesign-footer" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "I'll apply the footer update now.",
          toolCalls: [
            {
              id: "tool-call-2",
              toolName: "write_file",
              args: { path: "src/components/layout/Footer.tsx", content: "ok" },
            },
          ],
          usage: { promptTokens: 12, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Done.",
          toolCalls: [],
          usage: { promptTokens: 14, completionTokens: 7 },
        });

      vi.mocked(executor.execute!)
        .mockResolvedValueOnce({
          taskId: "tool-call-1",
          status: "FAILED",
          error: {
            message:
              "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/components/layout/Footer.tsx\nPlease commit your changes or stash them before you switch branches.\nAborting",
          },
          completedAt: new Date(),
        })
        .mockResolvedValueOnce({
          taskId: "tool-call-2",
          status: "DONE",
          output: {
            content: "Updated src/components/layout/Footer.tsx",
            metadata: {
              activity: {
                family: "edit",
                filePath: "src/components/layout/Footer.tsx",
                additions: 5,
                deletions: 2,
              },
            },
          },
          completedAt: new Date(),
        });

      const tools = {
        git_branch_switch: {
          description: "Switch branch",
        },
        write_file: {
          description: "Write file",
        },
      } as unknown as Record<string, import("ai").CoreTool>;

      const result = await loop.execute(
        [{ role: "user", content: "apply PR comment fix" }],
        tools,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.stepsExecuted).toBe(3);
      expect(result.failedToolCount).toBe(1);
      expect(result.completedMutatingToolCount).toBe(1);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(3);
      expect(result.toolLifecycle.map((event) => event.status)).toEqual([
        "requested",
        "started",
        "failed",
        "requested",
        "started",
        "completed",
      ]);
    });

    it("continues after unauthorized GitHub Actions job log failures to allow final synthesis", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Loading CI logs.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "github_actions_job_logs_get",
              args: {
                owner: "acme",
                repo: "career-crew",
                actionsJobId: 12345,
              },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "I could not access CI logs due to authorization limits.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "FAILED",
        error: {
          message:
            "GitHub API error (401): Unauthorized to access actions job logs.",
        },
        completedAt: new Date(),
      });

      const result = await loop.execute(
        [{ role: "user", content: "fetch CI logs" }],
        {
          github_actions_job_logs_get: {
            description: "Fetch Actions job logs",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.toolExecutionCount).toBe(1);
      expect(result.failedToolCount).toBe(1);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(2);
      const secondRequest = vi.mocked(llmGateway.generateText).mock
        .calls[1]?.[0] as {
        system?: string;
      };
      expect(secondRequest.system).toContain("CI logs auth-boundary fallback:");
      expect(secondRequest.system).toContain(
        "Attempt one bounded github_cli_actions_job_logs_get fallback for the same job logs before finalizing.",
      );
    });

    it("reserves the last step for synthesis instead of ending with a raw step-limit dump", async () => {
      const synthesisLoop = new AgenticLoop(
        {
          maxSteps: 2,
          runId: "run-123",
          sessionId: "session-123",
        },
        llmGateway as ILLMGateway,
        executor as TaskExecutor,
      );

      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "I'll inspect the repo first.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "git_status",
              args: {},
            },
          ],
          usage: { promptTokens: 8, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Your git branch is main and the working tree is clean.",
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 8 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: {
          content:
            '{"files":[],"ahead":0,"behind":0,"branch":"main","hasStaged":false,"hasUnstaged":false}',
        },
        completedAt: new Date(),
      });

      const tools = {
        git_status: {
          description: "Inspect git status",
        },
      } as unknown as Record<string, import("ai").CoreTool>;

      const result = await synthesisLoop.execute(
        [{ role: "user", content: "check my git info" }],
        tools,
        { agentType: "coding" },
      );

      expect(result.stopReason).toBe("llm_stop");
      expect(result.stepsExecuted).toBe(2);
      expect(llmGateway.generateText).toHaveBeenCalledTimes(2);
      const finalRequest = vi.mocked(llmGateway.generateText).mock
        .calls[1]?.[0] as {
        tools?: Record<string, unknown>;
        system?: string;
      };
      expect(finalRequest.tools).toBeUndefined();
      expect(finalRequest.system).toContain(
        "This is the final step. Do not call tools.",
      );
    });

    it("suppresses raw tool_call markup when structured tool calls are present", async () => {
      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "README.md" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: "README reviewed.",
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "README content" },
        completedAt: new Date(),
      });

      const result = await loop.execute(
        [{ role: "user", content: "read readme" }],
        {
          read_file: {
            description: "Read a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        { agentType: "coding" },
      );

      expect(result.messages[1]).toEqual({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        ],
      });
    });

    it("does not add mutation-forcing prompts after repeated read-only inspection on edit requests", async () => {
      const inspectionLoop = new AgenticLoop(
        {
          maxSteps: 6,
          runId: "run-123",
          sessionId: "session-123",
        },
        llmGateway as ILLMGateway,
        executor as TaskExecutor,
      );

      vi.mocked(llmGateway.generateText!)
        .mockResolvedValueOnce({
          text: "Inspecting hero.",
          toolCalls: [
            {
              id: "tool-call-1",
              toolName: "read_file",
              args: { path: "src/components/landing/hero/index.tsx" },
            },
          ],
          usage: { promptTokens: 8, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Inspecting testimonials.",
          toolCalls: [
            {
              id: "tool-call-2",
              toolName: "read_file",
              args: { path: "src/components/landing/testimonials/index.tsx" },
            },
          ],
          usage: { promptTokens: 8, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Inspecting stats.",
          toolCalls: [
            {
              id: "tool-call-3",
              toolName: "read_file",
              args: { path: "src/components/landing/stats/index.tsx" },
            },
          ],
          usage: { promptTokens: 8, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Inspecting blog card.",
          toolCalls: [
            {
              id: "tool-call-4",
              toolName: "read_file",
              args: { path: "src/components/landing/BlogPreviewCard.tsx" },
            },
          ],
          usage: { promptTokens: 8, completionTokens: 6 },
        })
        .mockResolvedValueOnce({
          text: "Final answer.",
          toolCalls: [],
          usage: { promptTokens: 8, completionTokens: 6 },
        });

      vi.mocked(executor.execute!).mockResolvedValue({
        taskId: "tool-call-1",
        status: "DONE",
        output: { content: "component contents" },
        completedAt: new Date(),
      });

      await inspectionLoop.execute(
        [
          {
            role: "user",
            content: "check my landing page and update it to be prettier",
          },
        ],
        {
          read_file: {
            description: "Read a file",
          },
        } as unknown as Record<string, import("ai").CoreTool>,
        { agentType: "coding" },
      );

      const correctiveRequest = vi.mocked(llmGateway.generateText).mock
        .calls[4]?.[0] as {
        system?: string;
      };
      expect(correctiveRequest.system).toContain("Edit-reporting rule:");
      expect(correctiveRequest.system).not.toContain("Progress correction:");
      expect(correctiveRequest.system).not.toContain("Corrective retry:");
      expect(correctiveRequest.system).not.toContain(
        "Stop broad inspection and attempt the concrete edit now",
      );
    });
  });

  describe("Statistics", () => {
    it("should track loop statistics", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );

      const stats = loop.getStats();
      expect(stats.stepsExecuted).toBe(1);
      expect(stats.toolExecutionCount).toBe(0);
      expect(stats.failedToolCount).toBe(0);
      expect(stats.maxSteps).toBe(5);
    });

    it("should reset statistics", async () => {
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );
      let stats = loop.getStats();
      expect(stats.stepsExecuted).toBe(1);

      loop.reset();
      stats = loop.getStats();
      expect(stats.stepsExecuted).toBe(0);
    });
  });

  describe("Budget Enforcement", () => {
    it("should check budget before LLM call", async () => {
      vi.mocked(budgetManager.isOverBudget!).mockResolvedValue(false);
      vi.mocked(llmGateway.generateText!).mockResolvedValue({
        text: "Done",
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      await loop.execute(
        [{ role: "user", content: "test" }],
        {},
        { agentType: "coding" },
      );

      expect(budgetManager.isOverBudget).toHaveBeenCalledWith("run-123");
    });

    it("should propagate non-budget errors from budget check", async () => {
      vi.mocked(budgetManager.isOverBudget!).mockRejectedValue(
        new Error("Storage unavailable"),
      );

      await expect(
        loop.execute(
          [{ role: "user", content: "test" }],
          {},
          { agentType: "coding" },
        ),
      ).rejects.toThrow("Storage unavailable");
    });
  });
});
