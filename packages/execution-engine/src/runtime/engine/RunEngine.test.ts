import { describe, expect, it, vi } from "vitest";
import {
  PRODUCT_MODES,
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  WORKFLOW_INTENTS,
} from "@repo/shared-types";
import { RunEngine, type RunEngineDependencies } from "./RunEngine.js";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";
import type {
  RuntimeDurableObjectState,
  RuntimeExecutionService,
  RuntimeStorage,
} from "../types.js";
import type { Task } from "../task/index.js";
import type { ILLMGateway } from "../llm/types.js";
import { Run, RunRepository } from "../run/index.js";
import { CodingAgent } from "../agents/CodingAgent.js";
import { RunEventRepository } from "../events/index.js";
import {
  LLMTimeoutError,
  LLMUnusableResponseError,
} from "../llm/LLMGateway.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";

const TEST_RUN_ID = "f462a003-5c36-4c86-a95d-367b92bf46c9";

describe("RunEngine", () => {
  it("routes greeting-only prompts through normal build execution", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: vi.fn(async () => {
        throw new Error("structured turn classification should be inactive");
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "hello",
        sessionId: "session-1",
      },
      [{ role: "user", content: "hello" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(generateText).toHaveBeenCalled();
  });

  it("does not bypass explicit plan mode planning for greeting-only prompts", async () => {
    const planner = {
      plan: vi.fn(async () => ({
        tasks: [],
        metadata: { estimatedSteps: 1 },
      })),
    } as unknown as RunEngineDependencies["planner"];
    const generateText = vi.fn(async () => ({
      text: "unused",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: vi.fn(async () => {
        throw new Error("structured turn classification should be inactive");
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway, planner });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "hey",
        sessionId: "session-1",
      },
      [{ role: "user", content: "hey" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(planner.plan).toHaveBeenCalled();
  });

  it("records deterministic permission context when creating a run", async () => {
    const runEngine = createRunEngine();
    await runEngine.execute(
      {
        agentType: "coding",
        prompt: "prepare a deployment summary",
        sessionId: "session-1",
        metadata: {
          permissionPolicy: {
            productMode: PRODUCT_MODES.FULL_AGENT,
          },
          workflow: {
            intent: WORKFLOW_INTENTS.SHIP,
          },
        },
      },
      [{ role: "user", content: "prepare a deployment summary" }],
      {},
    );

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);

    expect(persisted?.metadata.permissionContext?.state).toMatchObject({
      productMode: PRODUCT_MODES.FULL_AGENT,
      workflowIntent: WORKFLOW_INTENTS.SHIP,
    });
    expect(persisted?.metadata.permissionContext?.resolvedAt).toBeTruthy();
  });

  it("persists completed build-mode runs before emitting terminal events", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      runRepo: {
        update(run: Run): Promise<void>;
        updateUnlessStatus(
          run: Run,
          blockedStatuses: string[],
        ): Promise<boolean>;
      };
      runEventRecorder: {
        recordRunStatusChanged(
          previousStatus: string,
          currentStatus: string,
          step: string,
        ): Promise<void>;
        recordMessageEmitted(
          role: "user" | "assistant" | "system",
          content: string,
          metadata?: Record<string, unknown>,
        ): Promise<void>;
        recordRunCompleted(
          totalDurationMs: number,
          toolsUsed: number,
        ): Promise<void>;
      };
    };
    const callOrder: string[] = [];
    const originalRecordRunStatusChanged =
      privateApi.runEventRecorder.recordRunStatusChanged.bind(
        privateApi.runEventRecorder,
      );
    const originalRecordMessageEmitted =
      privateApi.runEventRecorder.recordMessageEmitted.bind(
        privateApi.runEventRecorder,
      );
    const originalRecordRunCompleted =
      privateApi.runEventRecorder.recordRunCompleted.bind(
        privateApi.runEventRecorder,
      );

    vi.spyOn(
      privateApi.runEventRecorder,
      "recordRunStatusChanged",
    ).mockImplementation(
      async (previousStatus: string, currentStatus: string, step: string) => {
        if (currentStatus === "COMPLETED") {
          callOrder.push("update");
        }
        return originalRecordRunStatusChanged(
          previousStatus,
          currentStatus,
          step,
        );
      },
    );
    vi.spyOn(
      privateApi.runEventRecorder,
      "recordMessageEmitted",
    ).mockImplementation(async (role, content, metadata) => {
      if (role === "assistant") {
        callOrder.push("message");
      }
      return originalRecordMessageEmitted(role, content, metadata);
    });
    vi.spyOn(
      privateApi.runEventRecorder,
      "recordRunCompleted",
    ).mockImplementation(async (totalDurationMs, toolsUsed) => {
      callOrder.push("completed");
      return originalRecordRunCompleted(totalDurationMs, toolsUsed);
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "hello",
        sessionId: "session-1",
      },
      [{ role: "user", content: "hello" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["update", "message", "completed"]);
  });

  it("returns a user-facing recovery message when explicit plan mode produces invalid structured output", async () => {
    const llmGateway: ILLMGateway = {
      generateText: async () => ({
        text: "unused",
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStructured: vi
        .fn()
        .mockRejectedValue(
          new Error("No object generated: response did not match schema."),
        ),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "continue with that",
        sessionId: "session-1",
      },
      [
        {
          role: "assistant",
          content:
            "I can inspect the repository and summarize the current state.",
        },
        {
          role: "user",
          content: "continue with that",
        },
      ],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("couldn't generate a valid structured plan");

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
        memoryCoordinator: {
          getCheckpointForResume(runId: string): Promise<
            | {
                phase: string;
                runStatus: string;
              }
            | undefined
          >;
        };
      }
    ).getRun(TEST_RUN_ID);
    const checkpoint = await (
      runEngine as unknown as {
        memoryCoordinator: {
          getCheckpointForResume(runId: string): Promise<
            | {
                phase: string;
                runStatus: string;
              }
            | undefined
          >;
        };
      }
    ).memoryCoordinator.getCheckpointForResume(TEST_RUN_ID);

    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.metadata.error).toBe(
      "PLANNER_INVALID_RESPONSE: Planner returned invalid structured output.",
    );
    expect(persisted?.metadata.phaseSelectionSnapshots?.synthesis).toEqual(
      persisted?.metadata.manifest,
    );
    expect(checkpoint).toMatchObject({
      phase: "synthesis",
      runStatus: "COMPLETED",
    });
  });

  it("completes with recoverable guidance when task execution times out in build mode", async () => {
    const state = new MockRuntimeState();
    const llmGateway: ILLMGateway = {
      generateText: vi.fn().mockRejectedValue(
        new LLMTimeoutError({
          timeoutMs: 60_000,
          phase: "task",
          operation: "text",
        }),
      ),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "update the footer CTA",
        sessionId: "session-1",
      },
      [{ role: "user", content: "update the footer CTA" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain(
      "The model timed out before choosing the next action.",
    );
    expect(output).toContain("No file was changed before the timeout.");

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.metadata.error).toBe(
      "TASK_EXECUTION_TIMEOUT: Model timed out before choosing the next action.",
    );

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    const assistantMessageEvent = [...events]
      .reverse()
      .find((event) => event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED);
    expect(assistantMessageEvent).toMatchObject({
      type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
      payload: {
        role: "assistant",
        metadata: {
          code: "TASK_EXECUTION_TIMEOUT",
          retryable: true,
        },
      },
    });
    expect(
      events.some((event) => event.type === RUN_EVENT_TYPES.RUN_FAILED),
    ).toBe(false);
  });

  it("completes with recoverable guidance when provider retries are exhausted during task execution", async () => {
    const state = new MockRuntimeState();
    const retryFailure = Object.assign(
      new Error(
        "Failed after 3 attempts. Last error: Internal error encountered.",
      ),
      {
        name: "AI_RetryError",
        cause: { statusCode: 500, message: "Internal error encountered." },
      },
    );
    const llmGateway: ILLMGateway = {
      generateText: vi.fn().mockRejectedValue(retryFailure),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "check my open PR and CI checks",
        sessionId: "session-1",
        providerId: "google",
        modelId: "gemma-4-31b-it",
      },
      [{ role: "user", content: "check my open PR and CI checks" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain(
      "The model provider became unavailable after repeated retries before the next action could be produced.",
    );
    expect(output).toContain("Provider status code: 500.");

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.metadata.error).toContain("PROVIDER_UNAVAILABLE:");

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    const assistantMessageEvent = [...events]
      .reverse()
      .find((event) => event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED);
    expect(assistantMessageEvent).toMatchObject({
      type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
      payload: {
        role: "assistant",
        metadata: {
          code: "PROVIDER_UNAVAILABLE",
          retryable: true,
        },
      },
    });
    expect(
      events.some((event) => event.type === RUN_EVENT_TYPES.RUN_FAILED),
    ).toBe(false);
  });

  it("keeps zero-action mutation runs on the normal no-change completion path", async () => {
    const state = new MockRuntimeState();
    const llmGateway: ILLMGateway = {
      generateText: vi.fn().mockResolvedValue({
        text: "Done.",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "update the footer CTA",
        sessionId: "session-1",
      },
      [{ role: "user", content: "update the footer CTA" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("No files were changed in this run.");
    expect(output).not.toContain(
      "The model did not return a usable next action for this edit request.",
    );

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.metadata.error).toBeUndefined();
    expect(persisted?.metadata.agenticLoop?.recoveryCode).toBeUndefined();

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    const assistantMessageEvent = [...events]
      .reverse()
      .find((event) => event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED);
    expect(assistantMessageEvent).toMatchObject({
      type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
      payload: {
        role: "assistant",
      },
    });
    expect(
      (assistantMessageEvent?.payload as { metadata?: unknown } | undefined)
        ?.metadata,
    ).toEqual({ terminalState: "completed" });
  });

  it("recovers exhausted unusable-response retries without failing the run", async () => {
    const state = new MockRuntimeState();
    const llmGateway: ILLMGateway = {
      generateText: vi
        .fn()
        .mockRejectedValueOnce(
          new LLMUnusableResponseError({
            providerId: "google",
            modelId: "gemini-2.5-flash-lite",
            anomalyCode: "EMPTY_CANDIDATE",
            finishReason: "stop",
            statusCode: 200,
          }),
        )
        .mockRejectedValueOnce(
          new LLMUnusableResponseError({
            providerId: "google",
            modelId: "gemini-2.5-flash-lite",
            anomalyCode: "EMPTY_CANDIDATE",
            finishReason: "stop",
            statusCode: 200,
          }),
        ),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "update the footer CTA",
        sessionId: "session-1",
      },
      [{ role: "user", content: "update the footer CTA" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain(
      "The model did not return a usable next action for this edit request.",
    );

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.metadata.error).toContain("TASK_MODEL_NO_ACTION:");
    expect(persisted?.metadata.agenticLoop?.recoveryCode).toBe(
      "TASK_MODEL_NO_ACTION",
    );
    expect(persisted?.metadata.agenticLoop?.llmRetryCount).toBe(1);
    expect(persisted?.metadata.agenticLoop?.terminalLlmIssue).toMatchObject({
      providerId: "google",
      modelId: "gemini-2.5-flash-lite",
      anomalyCode: "EMPTY_CANDIDATE",
      attempts: 2,
      statusCode: 200,
    });

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    expect(
      events.some((event) => event.type === RUN_EVENT_TYPES.RUN_FAILED),
    ).toBe(false);
  });

  it("persists PLANNING status before calling the explicit planner", async () => {
    const state = new MockRuntimeState();
    let observedPlanningStatus: string | null = null;
    const llmGateway: ILLMGateway = {
      generateText: async () => ({
        text: "Execution complete",
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
      }),
      generateStructured: async (request) => {
        if (request.context.phase !== "planning") {
          throw new Error("unexpected structured phase");
        }

        observedPlanningStatus =
          (await new RunRepository(state).getById(TEST_RUN_ID))?.status ?? null;

        return {
          object: {
            tasks: [],
            metadata: { estimatedSteps: 1 },
          },
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 5,
            completionTokens: 5,
            totalTokens: 10,
          },
        };
      },
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "plan it",
        sessionId: "session-1",
      },
      [{ role: "user", content: "plan it" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(observedPlanningStatus).toBe("PLANNING");
  });

  it("persists explicit-plan terminal state before emitting completion events", async () => {
    const runEngine = createRunEngine({
      llmGateway: createMockLLMGateway(),
    });
    const privateApi = runEngine as unknown as {
      runRepo: {
        update(run: Run): Promise<void>;
        updateUnlessStatus(
          run: Run,
          blockedStatuses: string[],
        ): Promise<boolean>;
      };
      runEventRecorder: {
        recordRunStatusChanged(
          previousStatus: string,
          currentStatus: string,
          step: string,
        ): Promise<void>;
        recordMessageEmitted(
          role: "user" | "assistant" | "system",
          content: string,
          metadata?: Record<string, unknown>,
        ): Promise<void>;
        recordRunCompleted(
          totalDurationMs: number,
          toolsUsed: number,
        ): Promise<void>;
      };
    };
    const callOrder: string[] = [];
    const originalRecordRunStatusChanged =
      privateApi.runEventRecorder.recordRunStatusChanged.bind(
        privateApi.runEventRecorder,
      );
    const originalRecordMessageEmitted =
      privateApi.runEventRecorder.recordMessageEmitted.bind(
        privateApi.runEventRecorder,
      );
    const originalRecordRunCompleted =
      privateApi.runEventRecorder.recordRunCompleted.bind(
        privateApi.runEventRecorder,
      );

    vi.spyOn(
      privateApi.runEventRecorder,
      "recordRunStatusChanged",
    ).mockImplementation(
      async (previousStatus: string, currentStatus: string, step: string) => {
        if (currentStatus === "COMPLETED") {
          callOrder.push("update");
        }
        return originalRecordRunStatusChanged(
          previousStatus,
          currentStatus,
          step,
        );
      },
    );
    vi.spyOn(
      privateApi.runEventRecorder,
      "recordMessageEmitted",
    ).mockImplementation(async (role, content, metadata) => {
      if (role === "assistant") {
        callOrder.push("message");
      }
      return originalRecordMessageEmitted(role, content, metadata);
    });
    vi.spyOn(
      privateApi.runEventRecorder,
      "recordRunCompleted",
    ).mockImplementation(async (totalDurationMs, toolsUsed) => {
      callOrder.push("completed");
      return originalRecordRunCompleted(totalDurationMs, toolsUsed);
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "plan this",
        sessionId: "session-1",
      },
      [{ role: "user", content: "plan this" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["update", "message", "completed"]);
  });

  it("build mode bypasses planner and reads files through the canonical tool loop", async () => {
    const planner = {
      plan: vi.fn(async () => {
        throw new Error(
          "planner should not be called for build-mode read requests",
        );
      }),
    } as unknown as RunEngineDependencies["planner"];
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: true,
        output: "# Shadowbox\n",
      })),
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Reading the requested file.",
        toolCalls: [
          {
            id: "call-1",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 3,
          completionTokens: 6,
          totalTokens: 9,
        },
      })
      .mockResolvedValueOnce({
        text: "README reviewed.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 5,
          totalTokens: 9,
        },
      });
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: vi.fn(async () => {
        throw new Error(
          "structured planning should be inactive for build mode",
        );
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = new RunEngine(
      new MockRuntimeState(),
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway, planner },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "read README.md",
        sessionId: "session-1",
      },
      [
        { role: "system", content: "internal system prompt" },
        { role: "assistant", content: "previous assistant reply" },
        { role: "user", content: "read README.md" },
      ],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("README reviewed.");
    expect(planner.plan).not.toHaveBeenCalled();
    expect(executionService.execute).toHaveBeenCalledWith(
      "filesystem",
      "read_file",
      { path: "README.md" },
      undefined,
    );
  });

  it("waits for approval and resumes tool execution after approval is resolved", async () => {
    const state = new MockRuntimeState();
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: true,
        output: "ok",
      })),
    };
    const llmGateway: ILLMGateway = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: "I will run tests now.",
          toolCalls: [
            {
              id: "bash-approval-1",
              toolName: "bash",
              args: { command: "pnpm test", cwd: "." },
            },
          ],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 8,
            totalTokens: 12,
          },
        })
        .mockResolvedValueOnce({
          text: "Completed after approval.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 6,
            totalTokens: 10,
          },
        }),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          APPROVAL_WAIT_TIMEOUT_MS: "5000",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );
    const approvalStore = new PermissionApprovalStore(state, TEST_RUN_ID);
    let resolvedRequestId: string | null = null;

    const responsePromise = runEngine.execute(
      {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      },
      [{ role: "user", content: "run tests" }],
      {},
    );

    const approvalResolutionPromise = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const pending = await approvalStore.getPendingRequest();
        if (pending) {
          resolvedRequestId = pending.requestId;
          await approvalStore.resolveDecision({
            kind: "allow_once",
            requestId: pending.requestId,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Timed out waiting for a pending approval request in test.",
      );
    })();

    const response = await responsePromise;
    await approvalResolutionPromise;

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Completed after approval.");
    expect(executionService.execute).toHaveBeenCalledWith(
      "bash",
      "run",
      expect.objectContaining({ command: "pnpm test" }),
      expect.anything(),
    );
    const pendingAfterResolution = await approvalStore.getPendingRequest();
    expect(pendingAfterResolution).toBeNull();
    expect(resolvedRequestId).toBeTruthy();

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    const approvalResolvedIndex = events.findIndex(
      (event) =>
        event.type === RUN_EVENT_TYPES.APPROVAL_RESOLVED &&
        event.payload.requestId === resolvedRequestId,
    );
    const firstToolTerminalIndex = events.findIndex(
      (event) =>
        event.type === RUN_EVENT_TYPES.TOOL_COMPLETED ||
        event.type === RUN_EVENT_TYPES.TOOL_FAILED,
    );

    expect(approvalResolvedIndex).toBeGreaterThan(-1);
    expect(firstToolTerminalIndex).toBeGreaterThan(-1);
    expect(approvalResolvedIndex).toBeLessThan(firstToolTerminalIndex);
  });

  it("formats approval-denied completion with terminal summary contract when enabled", async () => {
    const state = new MockRuntimeState();
    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1: "true",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      undefined,
      undefined,
      { llmGateway: createMockLLMGateway() },
    );
    const approvalStore = new PermissionApprovalStore(state, TEST_RUN_ID);
    await approvalStore.setPendingRequest({
      requestId: "req-deny-1",
      runId: TEST_RUN_ID,
      origin: "agent",
      category: "shell_command",
      title: "Run tests",
      reason: "This command can execute shell mutations.",
      command: "pnpm test",
      actionFingerprint: "shell:pnpm test",
      availableDecisions: ["deny", "allow_once"],
      createdAt: "2026-03-24T10:00:00.000Z",
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "deny that command",
        sessionId: "session-1",
        metadata: {
          permissionDecision: { kind: "deny", requestId: "req-deny-1" },
        },
      },
      [{ role: "user", content: "deny that command" }],
      {},
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(
      "Outcome: I could not continue because approval was denied.",
    );
    expect(text).toContain("What happened:");
    expect(text).toContain("What you can do next:");

    const persisted = await new RunRepository(state).getById(TEST_RUN_ID);
    expect(persisted?.metadata.terminalState).toBe("approval_denied");
  });

  it("uses deterministic failed-tool final summary contract when enabled", async () => {
    const state = new MockRuntimeState();
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: false,
        error:
          'npm error Missing script: "test" npm error To see a list of scripts, run: npm run',
      })),
    };
    const llmGateway: ILLMGateway = {
      generateText: vi.fn().mockResolvedValue({
        text: "I'll run tests now.",
        toolCalls: [
          {
            id: "bash-contract-1",
            toolName: "bash",
            args: { command: "pnpm test", cwd: "." },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 8,
          totalTokens: 12,
        },
      }),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1: "true",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      },
      [{ role: "user", content: "run tests" }],
      {},
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(
      "Outcome: I could not finish because a required tool step failed.",
    );
    expect(text).toContain("What happened:");
    expect(text).toContain("What you can do next:");

    const persisted = await new RunRepository(state).getById(TEST_RUN_ID);
    expect(persisted?.metadata.terminalState).toBe("failed_tool");
  });

  it("always frames failed-tool final messages so the run never appears to stop abruptly", async () => {
    const state = new MockRuntimeState();
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: false,
        error:
          'npm error Missing script: "test" npm error To see a list of scripts, run: npm run',
      })),
    };
    const llmGateway: ILLMGateway = {
      generateText: vi.fn().mockResolvedValue({
        text: "I'll run tests now.",
        toolCalls: [
          {
            id: "bash-contract-1",
            toolName: "bash",
            args: { command: "pnpm test", cwd: "." },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 8,
          totalTokens: 12,
        },
      }),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      },
      [{ role: "user", content: "run tests" }],
      {},
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(
      "Outcome: I could not finish because a required tool step failed.",
    );
    expect(text).toContain("What happened:");
    expect(text).toContain("What you can do next:");

    const persisted = await new RunRepository(state).getById(TEST_RUN_ID);
    expect(persisted?.output?.content).toContain(
      "Outcome: I could not finish because a required tool step failed.",
    );
    expect(persisted?.metadata.terminalState).toBe("failed_tool");
  });

  it("keeps a run cancelled when approval waiting is interrupted by user cancellation", async () => {
    const state = new MockRuntimeState();
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: true,
        output: "ok",
      })),
    };
    const llmGateway: ILLMGateway = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: "I will run tests now.",
          toolCalls: [
            {
              id: "bash-approval-cancel-1",
              toolName: "bash",
              args: { command: "pnpm test", cwd: "." },
            },
          ],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 8,
            totalTokens: 12,
          },
        })
        .mockResolvedValueOnce({
          text: "This should not be returned.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 6,
            totalTokens: 10,
          },
        }),
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          APPROVAL_WAIT_TIMEOUT_MS: "5000",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );
    const approvalStore = new PermissionApprovalStore(state, TEST_RUN_ID);

    const responsePromise = runEngine.execute(
      {
        agentType: "coding",
        prompt: "run tests",
        sessionId: "session-1",
      },
      [{ role: "user", content: "run tests" }],
      {},
    );

    const cancelPromise = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const pending = await approvalStore.getPendingRequest();
        if (pending) {
          await runEngine.cancel(TEST_RUN_ID);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Timed out waiting for a pending approval request in test.",
      );
    })();

    const response = await responsePromise;
    await cancelPromise;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(executionService.execute).not.toHaveBeenCalled();

    const run = await new RunRepository(state).getById(TEST_RUN_ID);
    expect(run?.status).toBe("CANCELLED");

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    expect(
      events.some((event) => event.type === RUN_EVENT_TYPES.RUN_COMPLETED),
    ).toBe(false);
  });

  it("records interrupted terminal summary message on cancel when contract is enabled", async () => {
    const state = new MockRuntimeState();
    const runId = "f462a003-5c36-4c86-a95d-367b92bf4701";
    const runtimeRunRepo = new RunRepository(state);
    await runtimeRunRepo.create(
      new Run(runId, "session-1", "RUNNING", "coding", {
        agentType: "coding",
        prompt: "cancel me",
        sessionId: "session-1",
      }),
    );
    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1: "true",
        } as unknown,
        sessionId: "session-1",
        runId,
      },
      undefined,
      undefined,
      { llmGateway: createMockLLMGateway() },
    );

    const cancelled = await runEngine.cancel(runId);

    expect(cancelled).toBe(true);
    const events = await new RunEventRepository(state).getByRun(runId);
    const assistantSummary = events.find(
      (event) =>
        event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED &&
        event.payload.role === "assistant",
    );
    expect(assistantSummary?.payload.content).toContain(
      "Outcome: The run was interrupted before it completed.",
    );
    expect(assistantSummary?.payload.metadata).toMatchObject({
      terminalState: "interrupted",
    });
  });

  it("keeps build mode running when planner would fail, because planner is inactive", async () => {
    const planner = {
      plan: vi.fn(async () => {
        throw new Error("planner timed out");
      }),
    } as unknown as RunEngineDependencies["planner"];
    const llmGateway = createMockLLMGateway();
    const runEngine = createRunEngine({ llmGateway, planner });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "summarize repository status",
        sessionId: "session-1",
      },
      [{ role: "user", content: "summarize repository status" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it("keeps explicit plan mode on the structured planner path", async () => {
    const planner = {
      plan: vi.fn(async () => ({
        tasks: [],
        metadata: { estimatedSteps: 1 },
      })),
    } as unknown as RunEngineDependencies["planner"];
    const runEngine = createRunEngine({
      llmGateway: createMockLLMGateway(),
      planner,
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "make a plan for the README changes",
        sessionId: "session-1",
      },
      [{ role: "user", content: "make a plan for the README changes" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(planner.plan).toHaveBeenCalledTimes(1);
  });

  it("completes explicit plan mode with a preserved handoff artifact and no task execution", async () => {
    const planner = {
      plan: vi.fn(async () => ({
        tasks: [
          {
            id: "task-1",
            type: "edit",
            description: "Update the README introduction",
            dependsOn: [],
            expectedOutput: "README intro is refreshed",
            input: { path: "README.md", content: "# Updated" },
          },
        ],
        metadata: {
          estimatedSteps: 1,
          reasoning: "Refresh the README copy before validating the update.",
        },
      })),
    } as unknown as RunEngineDependencies["planner"];
    const scheduler = {
      execute: vi.fn(async () => {
        throw new Error("scheduler should not run in explicit plan mode");
      }),
    } as unknown as RunEngineDependencies["scheduler"];
    const runEngine = createRunEngine({
      llmGateway: createMockLLMGateway(),
      planner,
      scheduler,
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "refresh the README intro",
        sessionId: "session-1",
      },
      [{ role: "user", content: "refresh the README intro" }],
      {},
    );

    const output = await response.text();
    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
        getTasksForRun(runId: string): Promise<Task[]>;
      }
    ).getRun(TEST_RUN_ID);
    const tasks = await (
      runEngine as unknown as {
        getTasksForRun(runId: string): Promise<Task[]>;
      }
    ).getTasksForRun(TEST_RUN_ID);

    expect(response.status).toBe(200);
    expect(output).toContain("No files, commands, or mutating tools were run");
    expect(output).not.toContain("Build handoff");
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
    expect(persisted?.metadata.planArtifact).toMatchObject({
      estimatedSteps: 1,
      summary: "Refresh the README copy before validating the update.",
      handoff: {
        targetMode: "build",
      },
    });
    expect(persisted?.metadata.planArtifact?.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        type: "edit",
        executionKind: "mutating",
      }),
    ]);
  });

  it("skips build-only approval and bootstrap gates in explicit plan mode", async () => {
    const planner = {
      plan: vi.fn(async () => ({
        tasks: [
          {
            id: "task-1",
            type: "analyze",
            description: "Inspect the current repository state",
            dependsOn: [],
            expectedOutput: "Current state understood",
            input: { path: "README.md" },
          },
        ],
        metadata: { estimatedSteps: 1 },
      })),
    } as unknown as RunEngineDependencies["planner"];
    const workspaceBootstrapper = {
      bootstrap: vi.fn(async () => ({
        status: "sync-failed" as const,
        message: "bootstrap should be skipped in plan mode",
      })),
    };
    const runEngine = createRunEngine({
      llmGateway: createMockLLMGateway(),
      planner,
      workspaceBootstrapper,
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt:
          "delete the old branch and force push once you inspect the repo",
        sessionId: "session-1",
        repositoryContext: {
          owner: "shadowbox",
          repo: "shadowbox",
          branch: "main",
        },
      },
      [
        {
          role: "user",
          content:
            "delete the old branch and force push once you inspect the repo",
        },
      ],
      {},
    );

    const output = await response.text();

    expect(response.status).toBe(200);
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(workspaceBootstrapper.bootstrap).not.toHaveBeenCalled();
    expect(output).not.toContain("approval");
    expect(output).toContain("Plan mode prepared a safe execution outline");
  });

  it("emits canonical run and tool lifecycle events for build-mode tool runs", async () => {
    const state = new MockRuntimeState();
    const llmGateway: ILLMGateway = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: "Reading the requested file.",
          toolCalls: [
            {
              id: "call-1",
              toolName: "read_file",
              args: { path: "README.md" },
            },
          ],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 3,
            completionTokens: 6,
            totalTokens: 9,
          },
        })
        .mockResolvedValueOnce({
          text: "README reviewed.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 5,
            totalTokens: 9,
          },
        }),
      generateStructured: vi.fn(async () => {
        throw new Error(
          "structured planning should be inactive for build mode",
        );
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngineForRun({
      state,
      dependencies: { llmGateway },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "read README.md",
        sessionId: "session-1",
      },
      [{ role: "user", content: "read README.md" }],
      {},
    );

    expect(response.status).toBe(200);

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        RUN_EVENT_TYPES.RUN_STARTED,
        RUN_EVENT_TYPES.MESSAGE_EMITTED,
        RUN_EVENT_TYPES.RUN_STATUS_CHANGED,
        RUN_EVENT_TYPES.RUN_PROGRESS,
        RUN_EVENT_TYPES.TOOL_REQUESTED,
        RUN_EVENT_TYPES.TOOL_STARTED,
        RUN_EVENT_TYPES.TOOL_COMPLETED,
        RUN_EVENT_TYPES.RUN_COMPLETED,
      ]),
    );
    expect(events[1]).toMatchObject({
      payload: {
        role: "user",
        content: "read README.md",
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED &&
          event.payload.workflowStep === RUN_WORKFLOW_STEPS.EXECUTION,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.RUN_STATUS_CHANGED &&
          event.payload.workflowStep === RUN_WORKFLOW_STEPS.SYNTHESIS,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.RUN_PROGRESS &&
          event.payload.label === "Thinking",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.TOOL_REQUESTED &&
          event.payload.toolName === "read_file" &&
          event.payload.description === "Read README.md" &&
          event.payload.displayText === "Reading README.md",
      ),
    ).toBe(true);
    expect(
      events.filter((event) => event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED),
    ).toMatchObject([
      {
        payload: {
          role: "user",
          content: "read README.md",
          transcriptPhase: "prompt",
        },
      },
      {
        payload: {
          role: "assistant",
          content: "Reading the requested file.",
          transcriptPhase: "commentary",
        },
      },
      {
        payload: {
          role: "assistant",
          content: "README reviewed.",
          transcriptPhase: "final_answer",
        },
      },
    ]);
  });

  it.skip("executes direct write-file requests through CodingAgent without planner decomposition", async () => {
    const planner = {
      plan: vi.fn(async () => {
        throw new Error(
          "planner should not be called for direct write requests",
        );
      }),
    } as unknown as RunEngineDependencies["planner"];
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: true,
        output: "Wrote 11 bytes to README.md",
      })),
    };
    const llmGateway = createMockLLMGateway();
    const runEngine = new RunEngine(
      new MockRuntimeState(),
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway, planner },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "write README.md\n```md\n# Shadowbox\n```",
        sessionId: "session-1",
      },
      [{ role: "user", content: "write README.md\n```md\n# Shadowbox\n```" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(executionService.execute).toHaveBeenCalledWith(
      "filesystem",
      "write_file",
      {
        path: "README.md",
        content: "# Shadowbox",
      },
      undefined,
    );
  });

  it("executes active agentic loop path when feature flag is enabled", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I will inspect the file first.",
        toolCalls: [
          {
            id: "call-1",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 3,
          completionTokens: 6,
          totalTokens: 9,
        },
      })
      .mockResolvedValueOnce({
        text: "README inspection complete.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 5,
          totalTokens: 9,
        },
      });
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const planner = {
      plan: vi.fn(async () => ({
        tasks: [],
        metadata: { estimatedSteps: 1 },
      })),
    } as unknown as RunEngineDependencies["planner"];
    const runEngine = createRunEngine({ llmGateway, planner });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "inspect README and summarize it",
        sessionId: "session-1",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
          branch: "main",
        },
        metadata: {
          featureFlags: {
            agenticLoopV1: true,
          },
        },
      },
      [{ role: "user", content: "inspect README and summarize it" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("README inspection complete.");
    expect(generateText).toHaveBeenCalledTimes(2);
    const firstRequest = generateText.mock.calls[0]?.[0] as {
      tools?: Record<string, unknown>;
      system?: string;
    };
    expect(firstRequest.tools).toBeDefined();
    expect(Object.keys(firstRequest.tools ?? {})).toContain("read_file");
    expect(firstRequest.system).toContain("Repository: sourcegraph/shadowbox");
    expect(firstRequest.system).toContain("Branch: main");
    expect(planner.plan).not.toHaveBeenCalled();

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.agenticLoop?.enabled).toBe(true);
    expect(persisted?.metadata.agenticLoop?.stopReason).toBe("llm_stop");
    expect(persisted?.metadata.agenticLoop?.toolExecutionCount).toBe(1);
    expect(persisted?.metadata.workspaceBootstrap).toMatchObject({
      requested: false,
      ready: true,
      status: "skipped",
      blocked: false,
    });
    expect(persisted?.metadata.gitTaskStrategy).toMatchObject({
      classification: "mutate_fix",
      preferredLane: "shell_git",
      fallbackLane: "typed_git",
    });
  });

  it("answers build-mode prompts without invoking structured turn classification", async () => {
    const generateText = vi.fn(async () => ({
      text: "Longer budget applied.",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const generateStructured = vi.fn(async () => ({
      object: { mode: "chat", rationale: "simple greeting" },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured,
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "hello",
        sessionId: "session-1",
      },
      [{ role: "user", content: "hello" }],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Longer budget applied.");
    expect(generateText).toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("keeps CI inspection read-only after prior mutation turns", async () => {
    const generateText = vi.fn(async () => ({
      text: "CI checks passed on the latest run.",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      },
    }));
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "check ci checks passed or not",
        sessionId: "session-1",
        metadata: {
          featureFlags: {
            agenticLoopV1: true,
          },
        },
      },
      [
        { role: "user", content: "edit footer and push it" },
        { role: "assistant", content: "I can do that." },
        { role: "user", content: "check ci checks passed or not" },
      ],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("CI checks passed on the latest run.");
    expect(output).not.toContain("did not complete the requested change");
  });

  it("completes the golden-flow tool roundtrip in one agentic run", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Executing golden flow tools now.",
        toolCalls: [
          { id: "t1", toolName: "list_files", args: { path: "." } },
          { id: "t2", toolName: "read_file", args: { path: "README.md" } },
          {
            id: "t3",
            toolName: "write_file",
            args: { path: "README.md", content: "# Updated README\n" },
          },
          {
            id: "t4",
            toolName: "bash",
            args: { command: "pnpm --filter @shadowbox/execution-engine test" },
          },
          { id: "t5", toolName: "git_diff", args: {} },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
        },
      })
      .mockResolvedValueOnce({
        text: "Golden flow completed without retries.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 8,
          completionTokens: 6,
          totalTokens: 14,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(
        async (
          plugin: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (plugin === "filesystem" && action === "list_files") {
            return { success: true, output: "README.md\npackages/\n" };
          }
          if (plugin === "filesystem" && action === "read_file") {
            return { success: true, output: "# Shadowbox\n" };
          }
          if (plugin === "filesystem" && action === "write_file") {
            return { success: true, output: "Wrote 17 bytes to README.md" };
          }
          if (plugin === "bash" && action === "run") {
            return { success: true, output: "test suite passed\n" };
          }
          if (plugin === "git" && action === "git_diff") {
            return {
              success: true,
              output: "diff --git a/README.md b/README.md",
            };
          }
          return {
            success: false,
            error: `Unexpected route ${plugin}:${action} ${JSON.stringify(payload)}`,
          };
        },
      ),
    };

    const runEngine = new RunEngine(
      new MockRuntimeState(),
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-golden-flow",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "Find the target file, update it, run tests, and show git diff",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        {
          role: "user",
          content:
            "Find the target file, update it, run tests, and show git diff",
        },
      ],
      {},
    );

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toContain(
      "I completed the requested update and changed this file:",
    );
    expect(responseText).toContain("README.md (+1 -1)");
    expect(responseText).toContain("Updated sections/components: README");

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    expect(executeSpy).toHaveBeenCalledWith(
      "filesystem",
      "list_files",
      {
        path: ".",
      },
      undefined,
    );
    expect(executeSpy).toHaveBeenCalledWith(
      "filesystem",
      "read_file",
      {
        path: "README.md",
      },
      undefined,
    );
    expect(executeSpy).toHaveBeenCalledWith(
      "filesystem",
      "write_file",
      {
        path: "README.md",
        content: "# Updated README\n",
      },
      undefined,
    );
    expect(executeSpy).toHaveBeenCalledWith("git", "git_diff", {}, undefined);

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.agenticLoop?.stopReason).toBe("tool_error");
    expect(persisted?.metadata.agenticLoop?.toolExecutionCount).toBe(5);
    expect(persisted?.metadata.agenticLoop?.failedToolCount).toBe(1);
    expect(persisted?.metadata.agenticLoop?.toolLifecycle).toHaveLength(15);
    expect(persisted?.metadata.agenticLoop?.toolLifecycle?.[0]).toMatchObject({
      toolCallId: "t1",
      toolName: "list_files",
      status: "requested",
      mutating: false,
    });
  });

  it("returns a truthful fallback summary when a build-mode tool fails", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "I'll update the file now.",
      toolCalls: [
        {
          id: "write-1",
          toolName: "write_file",
          args: { path: "README.md", content: "# Broken\n" },
        },
      ],
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      },
    });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async () => ({
        success: false,
        error: "Permission denied",
      })),
    };

    const runEngine = new RunEngine(
      new MockRuntimeState(),
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-tool-failure",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "update README.md",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "update README.md" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain(
      "I stopped because a required tool action failed.",
    );
    expect(output).toContain(
      "A required file edit step failed: Permission denied",
    );
    expect(output).not.toContain(
      "did not complete the requested change because no mutating tool succeeded",
    );
    expect(output).not.toContain("Retry with a more specific target file");
    expect(output).not.toContain("I'll update the file now.");

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.agenticLoop?.stopReason).toBe("tool_error");
    expect(
      persisted?.metadata.agenticLoop?.toolLifecycle?.map(
        (event) => event.status,
      ),
    ).toEqual(["requested", "started", "failed"]);
  });

  it("preserves continuation context across recycled runs when risky git actions are gated", async () => {
    const state = new MockRuntimeState();
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll update the hero and try to commit it.",
        toolCalls: [
          {
            id: "write-hero-1",
            toolName: "write_file",
            args: {
              path: "src/components/landing/hero/FloatingCarousels.tsx",
              content:
                "export function FloatingCarousels() {\n  return null;\n}\n",
            },
          },
          {
            id: "git-shell-1",
            toolName: "bash",
            args: {
              command:
                'git add src/components/landing/hero/FloatingCarousels.tsx && git commit -m "feat: add floating carousels\n\nbody"',
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 8,
          completionTokens: 10,
          totalTokens: 18,
        },
      })
      .mockImplementationOnce(async (request) => {
        const system = String(
          (
            request as {
              system?: string;
            }
          ).system ?? "",
        );

        expect(system).toContain("Continuation context:");
        expect(system).toContain(
          "Previous request: make the hero prettier and commit the change",
        );
        expect(system).toContain(
          "Files already changed in the workspace: src/components/landing/hero/FloatingCarousels.tsx",
        );
        expect(system).toContain(
          "Last failed step: bash - LegionCode wants to run a shell command",
        );
        expect(system).toContain(
          "Prefer typed git tools for repository work (status, diff, branch, stage, commit, push, PR) to keep actions structured and auditable.",
        );

        return {
          text: "I'll finish the git work with dedicated actions.",
          toolCalls: [
            {
              id: "git-stage-1",
              toolName: "git_stage",
              args: {
                files: ["src/components/landing/hero/FloatingCarousels.tsx"],
              },
            },
            {
              id: "git-commit-1",
              toolName: "git_commit",
              args: {
                message: "feat: add floating carousels to hero section",
              },
            },
          ],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 7,
            completionTokens: 9,
            totalTokens: 16,
          },
        };
      })
      .mockResolvedValueOnce({
        text: "Committed the carousel changes successfully.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 5,
          completionTokens: 4,
          totalTokens: 9,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(
        async (
          plugin: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (plugin === "filesystem" && action === "read_file") {
            return {
              success: false,
              error: "ENOENT: no such file or directory",
            };
          }
          if (plugin === "filesystem" && action === "write_file") {
            return {
              success: true,
              output:
                "Wrote 56 bytes to src/components/landing/hero/FloatingCarousels.tsx",
            };
          }
          if (plugin === "bash" && action === "run") {
            return {
              success: false,
              error:
                "Invalid command argument: multiline values are not allowed",
            };
          }
          if (plugin === "git" && action === "git_stage") {
            return {
              success: true,
              output:
                "Staged src/components/landing/hero/FloatingCarousels.tsx",
            };
          }
          if (plugin === "git" && action === "git_commit") {
            return {
              success: true,
              output:
                "[feature/floating-hero-carousels abc1234] feat: add floating carousels to hero section",
            };
          }
          return {
            success: false,
            error: `Unexpected route ${plugin}:${action} ${JSON.stringify(payload)}`,
          };
        },
      ),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-continue-git-recovery",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const firstResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "make the hero prettier and commit the change",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        {
          role: "user",
          content: "make the hero prettier and commit the change",
        },
      ],
      {},
    );

    expect(firstResponse.status).toBe(200);
    const firstOutput = await firstResponse.text();
    expect(firstOutput).toContain("LegionCode wants to run a shell command");

    const firstPersistedRun = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    const failedShellEvent =
      firstPersistedRun?.metadata.agenticLoop?.toolLifecycle
        ?.slice()
        .reverse()
        .find((event) => event.status === "failed");
    expect(failedShellEvent?.toolName).toBe("bash");
    expect(String(failedShellEvent?.detail ?? "")).toContain(
      "LegionCode wants to run a shell command",
    );

    const firstRunEvents = await new RunEventRepository(state).getByRun(
      TEST_RUN_ID,
    );
    const firstAssistantEvent = [...firstRunEvents]
      .reverse()
      .find(
        (event) =>
          event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED &&
          event.payload.role === "assistant",
      );
    expect(firstAssistantEvent?.payload.metadata).toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      retryable: true,
    });
    expect(
      String(firstAssistantEvent?.payload.metadata?.resumeHint ?? ""),
    ).toContain(
      "Retry the shell step. If it keeps failing, run the equivalent command in your local terminal.",
    );

    const secondResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        {
          role: "user",
          content: "make the hero prettier and commit the change",
        },
        {
          role: "assistant",
          content: firstOutput,
        },
        {
          role: "user",
          content: "continue?",
        },
      ],
      {},
    );

    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.text()).toContain(
      "LegionCode wants to run a shell command",
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_stage",
      expect.anything(),
      undefined,
    );
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_commit",
      expect.anything(),
      undefined,
    );

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.continuation).toMatchObject({
      previousPrompt: "make the hero prettier and commit the change",
      failedToolName: "bash",
      completedFiles: ["src/components/landing/hero/FloatingCarousels.tsx"],
    });
    expect(persisted?.metadata.agenticLoop?.stopReason).toBe("tool_error");
  });

  it("preserves continuation guidance after branch creation is blocked by approval gates", async () => {
    const state = new MockRuntimeState();
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll branch, commit, push, and open the PR.",
        toolCalls: [
          {
            id: "git-branch-1",
            toolName: "git_branch_create",
            args: {
              branch: "feat/floating-hero-carousels",
            },
          },
          {
            id: "git-stage-1",
            toolName: "git_stage",
            args: {
              files: [
                "src/components/landing/hero/FloatingCarousels.tsx",
                "src/components/landing/hero/index.tsx",
              ],
            },
          },
          {
            id: "git-commit-1",
            toolName: "git_commit",
            args: {
              message: "feat: add floating carousels to hero section",
            },
          },
          {
            id: "git-push-1",
            toolName: "git_push",
            args: {
              branch: "feat/floating-hero-carousels",
              remote: "origin",
            },
          },
          {
            id: "bash-pr-1",
            toolName: "bash",
            args: {
              command:
                'gh pr create --base main --head feat/floating-hero-carousels --title "feat: add floating carousels to hero section"',
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 9,
          completionTokens: 10,
          totalTokens: 19,
        },
      })
      .mockImplementationOnce(async (request) => {
        const system = String(
          (
            request as {
              system?: string;
            }
          ).system ?? "",
        );

        expect(system).toContain("Continuation context:");
        expect(system).toContain("Previous request:");
        expect(system).toContain("Last failed step:");
        expect(system).toContain("LegionCode wants to create a branch");
        expect(system).toContain(
          "Do not repeat successful inspection or rewrite already-updated files unless the current workspace proves the change is missing.",
        );

        return {
          text: "I need explicit approval before continuing git mutation steps.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 7,
            completionTokens: 8,
            totalTokens: 15,
          },
        };
      })
      .mockResolvedValueOnce({
        text: "The pull request is now created.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 5,
          completionTokens: 4,
          totalTokens: 9,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(
        async (
          plugin: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (plugin === "git" && action === "git_branch_create") {
            return {
              success: true,
              output: "Switched to a new branch 'feat/floating-hero-carousels'",
            };
          }
          if (plugin === "git" && action === "git_stage") {
            return {
              success: true,
              output:
                "Staged src/components/landing/hero/FloatingCarousels.tsx, src/components/landing/hero/index.tsx",
            };
          }
          if (plugin === "git" && action === "git_commit") {
            return {
              success: true,
              output:
                "[feat/floating-hero-carousels abc1234] feat: add floating carousels to hero section",
            };
          }
          if (plugin === "git" && action === "git_push") {
            return {
              success: true,
              output:
                "branch 'feat/floating-hero-carousels' set up to track 'origin/feat/floating-hero-carousels'",
            };
          }
          if (plugin === "git" && action === "git_create_pull_request") {
            return {
              success: true,
              output:
                "Created pull request #221: https://github.com/sourcegraph/shadowbox/pull/221",
            };
          }
          if (plugin === "bash" && action === "run") {
            return {
              success: false,
              error:
                "Invalid arguments for tool bash: command exceeded the maximum length",
            };
          }
          return {
            success: false,
            error: `Unexpected route ${plugin}:${action} ${JSON.stringify(payload)}`,
          };
        },
      ),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-pr-recovery",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const firstResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "commit it, create a new branch and create a pr on github",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        {
          role: "user",
          content: "commit it, create a new branch and create a pr on github",
        },
      ],
      {},
    );

    expect(firstResponse.status).toBe(200);
    const firstOutput = await firstResponse.text();
    expect(firstOutput).toContain("LegionCode wants to create a branch");

    const secondResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        {
          role: "user",
          content: "commit it, create a new branch and create a pr on github",
        },
        {
          role: "assistant",
          content: firstOutput,
        },
        {
          role: "user",
          content: "continue?",
        },
      ],
      {},
    );

    expect(secondResponse.status).toBe(200);
    const secondOutput = await secondResponse.text();
    expect(secondOutput).toContain(
      "I need explicit approval before continuing git mutation steps.",
    );
    expect(secondOutput).not.toContain(
      "The model did not return a usable next action for this edit request.",
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_create_pull_request",
      expect.anything(),
      undefined,
    );

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.continuation).toMatchObject({
      previousPrompt:
        "commit it, create a new branch and create a pr on github",
      completedGitSteps: [],
    });
  });

  it("carries continuation failure context when git mutation evidence is missing", async () => {
    const state = new MockRuntimeState();
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll commit and push the branch.",
        toolCalls: [
          {
            id: "git-stage-1",
            toolName: "git_stage",
            args: {
              files: [
                "src/components/landing/hero/FloatingCarousels.tsx",
                "src/components/landing/hero/index.tsx",
              ],
            },
          },
          {
            id: "git-commit-1",
            toolName: "git_commit",
            args: {
              message: "feat: add floating carousels to hero section",
            },
          },
          {
            id: "git-push-1",
            toolName: "git_push",
            args: {
              branch: "feat/floating-hero-carousels",
              remote: "origin",
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 7,
          completionTokens: 8,
          totalTokens: 15,
        },
      })
      .mockImplementationOnce(async (request) => {
        const system = String(
          (
            request as {
              system?: string;
            }
          ).system ?? "",
        );

        expect(system).toContain("Continuation context:");
        expect(system).toContain("Last failed step: git_push -");
        expect(system).toContain(
          "LegionCode cannot continue with git push yet because no successful file mutation or committed-change evidence exists in this run.",
        );

        return {
          text: "I still need file mutation evidence before push actions.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 6,
            completionTokens: 7,
            totalTokens: 13,
          },
        };
      })
      .mockResolvedValueOnce({
        text: "The branch is now synced and pushed.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 4,
          totalTokens: 8,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    let pushAttempt = 0;
    const executionService: RuntimeExecutionService = {
      execute: vi.fn(
        async (
          plugin: string,
          action: string,
          payload: Record<string, unknown>,
        ) => {
          if (plugin === "git" && action === "git_stage") {
            return {
              success: true,
              output:
                "Staged src/components/landing/hero/FloatingCarousels.tsx, src/components/landing/hero/index.tsx",
            };
          }
          if (plugin === "git" && action === "git_commit") {
            return {
              success: true,
              output:
                "[feat/floating-hero-carousels abc1234] feat: add floating carousels to hero section",
            };
          }
          if (plugin === "git" && action === "git_push") {
            pushAttempt += 1;
            if (pushAttempt === 1) {
              return {
                success: false,
                error:
                  "Push failed because origin/feat/floating-hero-carousels already has newer commits. Your file changes are already committed locally.",
              };
            }
            return {
              success: true,
              output:
                "branch 'feat/floating-hero-carousels' set up to track 'origin/feat/floating-hero-carousels'",
            };
          }
          if (plugin === "git" && action === "git_pull") {
            return {
              success: true,
              output:
                "Already up to date after fast-forward sync for feat/floating-hero-carousels",
            };
          }
          return {
            success: false,
            error: `Unexpected route ${plugin}:${action} ${JSON.stringify(payload)}`,
          };
        },
      ),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-push-recovery",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const firstResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "commit and push the branch",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "commit and push the branch" }],
      {},
    );

    expect(firstResponse.status).toBe(200);
    const firstOutput = await firstResponse.text();
    expect(firstOutput).toContain(
      "LegionCode cannot continue with git push yet because no successful file mutation or committed-change evidence exists in this run.",
    );

    const secondResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        { role: "user", content: "commit and push the branch" },
        { role: "assistant", content: firstOutput },
        { role: "user", content: "continue?" },
      ],
      {},
    );

    expect(secondResponse.status).toBe(200);
    const secondOutput = await secondResponse.text();
    expect(secondOutput).toContain(
      "I still need file mutation evidence before push actions.",
    );
    expect(secondOutput).not.toContain(
      "The model did not return a usable next action for this edit request.",
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_pull",
      expect.anything(),
      undefined,
    );
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_push",
      expect.anything(),
      undefined,
    );
  });

  it("keeps continuation push blocked when prior commit identity was not OAuth-backed", async () => {
    const state = new MockRuntimeState();
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll edit, commit, and push.",
        toolCalls: [
          {
            id: "write-1",
            toolName: "write_file",
            args: {
              path: "src/components/layout/Footer.tsx",
              content: "updated footer content",
            },
          },
          {
            id: "git-commit-1",
            toolName: "git_commit",
            args: {
              message:
                "feat: add coming soon indicator to newsletter subscription in footer",
            },
          },
          {
            id: "git-push-1",
            toolName: "git_push",
            args: {
              branch: "style/redesign-footer",
              remote: "origin",
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 8,
          completionTokens: 8,
          totalTokens: 16,
        },
      })
      .mockResolvedValueOnce({
        text: "I'll retry push now.",
        toolCalls: [
          {
            id: "git-push-2",
            toolName: "git_push",
            args: {
              branch: "style/redesign-footer",
              remote: "origin",
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async (plugin: string, action: string) => {
        if (plugin === "filesystem" && action === "read_file") {
          return { success: false, error: "File not found" };
        }
        if (plugin === "filesystem" && action === "write_file") {
          return { success: true, output: "File updated" };
        }
        if (plugin === "git" && action === "git_commit") {
          return {
            success: true,
            output: {
              content: "Changes committed",
              commitIdentity: {
                source: "user_input",
                verified: false,
              },
            },
          };
        }
        if (plugin === "git" && action === "git_push") {
          return {
            success: false,
            error:
              "error: src refspec style/redesign-footer does not match any\nerror: failed to push some refs",
          };
        }
        return {
          success: false,
          error: `Unexpected route ${plugin}:${action}`,
        };
      }),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          APPROVAL_WAIT_TIMEOUT_MS: "5000",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-untrusted-commit-resume-push",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );
    const approvalStore = new PermissionApprovalStore(state, TEST_RUN_ID);

    const firstResponsePromise = runEngine.execute(
      {
        agentType: "coding",
        prompt: "update footer, commit, and push",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: {
          featureFlags: { agenticLoopV1: true },
          permissionPolicy: { productMode: "full_agent" },
        },
      },
      [{ role: "user", content: "update footer, commit, and push" }],
      {},
    );
    const approvalResolutionPromise = (async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const pending = await approvalStore.getPendingRequest();
        if (pending) {
          await approvalStore.resolveDecision({
            kind: "allow_once",
            requestId: pending.requestId,
          });
          continue;
        }

        const status = await runEngine.getRunStatus(TEST_RUN_ID);
        if (
          status === "COMPLETED" ||
          status === "FAILED" ||
          status === "CANCELLED"
        ) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      throw new Error("Timed out resolving pending approval requests in test.");
    })();

    const firstResponse = await firstResponsePromise;
    await approvalResolutionPromise;
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();

    const secondResponse = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        { role: "user", content: "update footer, commit, and push" },
        { role: "assistant", content: "Push failed, retrying." },
        { role: "user", content: "continue?" },
      ],
      {},
    );

    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.text()).toContain(
      "no successful file mutation or committed-change evidence exists in this run",
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    const pushCalls = executeSpy.mock.calls.filter(
      ([plugin, action]) => plugin === "git" && action === "git_push",
    );
    expect(pushCalls).toHaveLength(1);
  });

  it("allows git_stage when git_status confirms existing local workspace changes", async () => {
    const state = new MockRuntimeState();
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll stage the pending footer change now.",
        toolCalls: [
          {
            id: "git-stage-1",
            toolName: "git_stage",
            args: {
              files: ["src/components/layout/Footer.tsx"],
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 6,
          completionTokens: 6,
          totalTokens: 12,
        },
      })
      .mockResolvedValueOnce({
        text: "Staging completed.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 4,
          totalTokens: 8,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async (plugin: string, action: string) => {
        if (plugin === "git" && action === "git_status") {
          return {
            success: true,
            output: JSON.stringify({
              branch: "style/redesign-footer",
              hasStaged: false,
              hasUnstaged: true,
              files: [
                {
                  path: "src/components/layout/Footer.tsx",
                  status: "M",
                  staged: false,
                },
              ],
            }),
          };
        }
        if (plugin === "git" && action === "git_stage") {
          return {
            success: true,
            output: "Staged src/components/layout/Footer.tsx",
          };
        }
        return {
          success: false,
          error: `Unexpected route ${plugin}:${action}`,
        };
      }),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          APPROVAL_WAIT_TIMEOUT_MS: "5000",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-git-stage-workspace-evidence",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );
    const approvalStore = new PermissionApprovalStore(state, TEST_RUN_ID);

    const responsePromise = runEngine.execute(
      {
        agentType: "coding",
        prompt: "stage the footer changes",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "stage the footer changes" }],
      {},
    );
    const approvalResolutionPromise = (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const pending = await approvalStore.getPendingRequest();
        if (pending) {
          await approvalStore.resolveDecision({
            kind: "allow_once",
            requestId: pending.requestId,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Timed out waiting for git_stage approval request in test.",
      );
    })();

    const response = await responsePromise;
    await approvalResolutionPromise;

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).not.toContain(
      "no successful file mutation has occurred in this run",
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    const statusCallIndex = executeSpy.mock.calls.findIndex(
      ([plugin, action]) => plugin === "git" && action === "git_status",
    );
    const stageCallIndex = executeSpy.mock.calls.findIndex(
      ([plugin, action]) => plugin === "git" && action === "git_stage",
    );
    expect(statusCallIndex).toBeGreaterThanOrEqual(0);
    expect(stageCallIndex).toBeGreaterThan(statusCallIndex);
  });

  it("asks for scope when git mutation request does not match local diff", async () => {
    const state = new MockRuntimeState();
    const generateText = vi.fn().mockResolvedValueOnce({
      text: "I'll stage the footer change now.",
      toolCalls: [
        {
          id: "git-stage-1",
          toolName: "git_stage",
          args: {
            files: ["src/components/layout/Footer.tsx"],
          },
        },
      ],
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 6,
        completionTokens: 6,
        totalTokens: 12,
      },
    });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async (plugin: string, action: string) => {
        if (plugin === "git" && action === "git_status") {
          return {
            success: true,
            output: JSON.stringify({
              branch: "style/redesign-footer",
              hasStaged: false,
              hasUnstaged: true,
              files: [
                {
                  path: "README.md",
                  status: "M",
                  staged: false,
                },
              ],
            }),
          };
        }

        return {
          success: false,
          error: `Unexpected route ${plugin}:${action}`,
        };
      }),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: {
          NODE_ENV: "test",
          APPROVAL_WAIT_TIMEOUT_MS: "2000",
        } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-git-stage-scope-mismatch",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway },
    );

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "stage the footer changes",
        sessionId: "session-1",
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "stage the footer changes" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("scope decision");
    expect(output).toContain("Detected changed files: README.md");

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    expect(executeSpy).not.toHaveBeenCalledWith(
      "git",
      "git_stage",
      expect.anything(),
      undefined,
    );
  });

  it("bootstraps recycled continuation turns onto the preserved active branch", async () => {
    const state = new MockRuntimeState();
    const workspaceBootstrapper = {
      bootstrap: vi.fn(async () => ({ status: "ready" as const })),
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll create the branch and push it.",
        toolCalls: [
          {
            id: "git-branch-1",
            toolName: "git_branch_create",
            args: {
              branch: "feat/floating-hero-carousels",
            },
          },
          {
            id: "git-push-1",
            toolName: "git_push",
            args: {
              branch: "feat/floating-hero-carousels",
              remote: "origin",
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 6,
          completionTokens: 8,
          totalTokens: 14,
        },
      })
      .mockResolvedValueOnce({
        text: "The branch step failed and needs another try.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 4,
          totalTokens: 8,
        },
      })
      .mockImplementationOnce(async (request) => {
        const system = String(
          (
            request as {
              system?: string;
            }
          ).system ?? "",
        );
        expect(system).toContain("Resume on branch: main");
        return {
          text: "Continuing on the preserved branch.",
          toolCalls: [],
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 4,
            completionTokens: 4,
            totalTokens: 8,
          },
        };
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(async (plugin: string, action: string) => {
        if (plugin === "git" && action === "git_branch_create") {
          return {
            success: true,
            output:
              "Created and switched to branch: feat/floating-hero-carousels",
          };
        }
        if (plugin === "git" && action === "git_push") {
          return {
            success: false,
            error:
              "error: src refspec feat/floating-hero-carousels does not match any",
          };
        }
        return {
          success: false,
          error: `Unexpected route ${plugin}:${action}`,
        };
      }),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-branch-bootstrap",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway, workspaceBootstrapper },
    );

    await runEngine.execute(
      {
        agentType: "coding",
        prompt: "create a branch and push it",
        sessionId: "session-1",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
          branch: "main",
        },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "create a branch and push it" }],
      {},
    );

    await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
          branch: "main",
        },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        { role: "user", content: "create a branch and push it" },
        {
          role: "assistant",
          content: "The branch step failed and needs another try.",
        },
        { role: "user", content: "continue?" },
      ],
      {},
    );

    expect(workspaceBootstrapper.bootstrap).toHaveBeenNthCalledWith(1, {
      runId: TEST_RUN_ID,
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });
    expect(workspaceBootstrapper.bootstrap).toHaveBeenNthCalledWith(2, {
      runId: TEST_RUN_ID,
      mode: "mutation",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    expect(
      events.some(
        (event) =>
          event.type === RUN_EVENT_TYPES.RUN_PROGRESS &&
          event.payload.label === "Workspace bootstrap",
      ),
    ).toBe(false);
  });

  it("restores persisted workspace edits when bootstrap had to recreate the repo", async () => {
    const state = new MockRuntimeState();
    const workspaceBootstrapper = {
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce({
          status: "ready" as const,
          clonedDuringBootstrap: false,
        })
        .mockResolvedValueOnce({
          status: "ready" as const,
          clonedDuringBootstrap: true,
        }),
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: "I'll update the hero file.",
        toolCalls: [
          {
            id: "write-hero-1",
            toolName: "write_file",
            args: {
              path: "src/components/landing/hero/index.tsx",
              content: "export const hero = 'floating';\n",
            },
          },
        ],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 4,
          completionTokens: 8,
          totalTokens: 12,
        },
      })
      .mockResolvedValueOnce({
        text: "Hero updated.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        },
      })
      .mockResolvedValueOnce({
        text: "Continuing from the restored workspace.",
        toolCalls: [],
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        },
      });

    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };

    const executionService: RuntimeExecutionService = {
      execute: vi.fn(
        async (
          plugin: string,
          action: string,
          payload?: Record<string, unknown>,
        ) => {
          if (plugin === "filesystem" && action === "read_file") {
            return {
              success: false,
              error: "File not found",
            };
          }
          if (
            plugin === "filesystem" &&
            action === "write_file" &&
            payload?.path === "src/components/landing/hero/index.tsx"
          ) {
            return {
              success: true,
              output: "File written successfully",
            };
          }
          if (plugin === "git" && action === "git_status") {
            return {
              success: true,
              output: JSON.stringify({
                branch: "main",
                files: [],
                repoIdentity: "github.com/acme/career-crew",
                hasStaged: false,
                hasUnstaged: false,
                gitAvailable: true,
              }),
            };
          }
          return {
            success: false,
            error: `Unexpected route ${plugin}:${action}`,
          };
        },
      ),
    };

    const runEngine = new RunEngine(
      state,
      {
        env: { NODE_ENV: "test" } as unknown,
        sessionId: "session-1",
        runId: TEST_RUN_ID,
        correlationId: "corr-restore-edits",
      },
      new CodingAgent(llmGateway, executionService),
      undefined,
      { llmGateway, workspaceBootstrapper },
    );

    await runEngine.execute(
      {
        agentType: "coding",
        prompt: "add floating hero markup",
        sessionId: "session-1",
        repositoryContext: {
          owner: "acme",
          repo: "career-crew",
          branch: "main",
        },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [{ role: "user", content: "add floating hero markup" }],
      {},
    );

    await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue?",
        sessionId: "session-1",
        repositoryContext: {
          owner: "acme",
          repo: "career-crew",
          branch: "main",
        },
        metadata: { featureFlags: { agenticLoopV1: true } },
      },
      [
        { role: "user", content: "add floating hero markup" },
        { role: "assistant", content: "Hero updated." },
        { role: "user", content: "continue?" },
      ],
      {},
    );

    const executeSpy = executionService.execute as ReturnType<typeof vi.fn>;
    const restoredWrites = executeSpy.mock.calls.filter(
      ([plugin, action, payload]) =>
        plugin === "filesystem" &&
        action === "write_file" &&
        payload?.path === "src/components/landing/hero/index.tsx" &&
        payload?.content === "export const hero = 'floating';\n",
    );
    expect(restoredWrites).toHaveLength(2);
    expect(workspaceBootstrapper.bootstrap).toHaveBeenNthCalledWith(2, {
      runId: TEST_RUN_ID,
      mode: "mutation",
      repositoryContext: {
        owner: "acme",
        repo: "career-crew",
        branch: "main",
      },
    });
  });

  it("enforces the bounded golden-flow tool floor for agentic-loop tool maps", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "done",
      toolCalls: [],
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    });
    const llmGateway: ILLMGateway = {
      generateText,
      generateStructured: async () => ({
        object: { tasks: [], metadata: { estimatedSteps: 1 } },
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "inspect repository",
        sessionId: "session-1",
        metadata: { featureFlags: { agenticLoopV1: true } },
        repositoryContext: { owner: "sourcegraph", repo: "shadowbox" },
      },
      [{ role: "user", content: "inspect repository" }],
      {
        web_search: {
          description: "not in scope",
        } as unknown as import("ai").CoreTool,
      },
    );

    expect(response.status).toBe(200);
    const firstRequest = generateText.mock.calls[0]?.[0] as {
      tools?: Record<string, unknown>;
    };
    const toolNames = Object.keys(firstRequest.tools ?? {});
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("web_search");
  });

  it("sanitizes internal runtime paths in user-facing output", () => {
    const leaked =
      "cat: /home/sandbox/runs/5212f17b-eb1f-463f-a41f-2c4c6b9d4ba6/README.md: No such file or directory\nSee https://internal/debug";
    const sanitized = sanitizeUserFacingOutput(leaked);

    expect(sanitized).not.toContain(
      "/home/sandbox/runs/5212f17b-eb1f-463f-a41f-2c4c6b9d4ba6/",
    );
    expect(sanitized).toContain(
      "The requested file was not found in the current workspace.",
    );
    expect(sanitized).toContain("[internal-url]");
  });

  it("strips leaked internal-style reasoning preface from user-facing output", () => {
    const leaked =
      "The user asked me to check PR #58. I need to inspect branch state first. First, I'll check git status. The current branch is main. Wait, I should switch branches. I found the issue in Footer.tsx.";

    const sanitized = sanitizeUserFacingOutput(leaked);

    expect(sanitized).toBe("I found the issue in Footer.tsx.");
    expect(sanitized).not.toContain("The user asked");
    expect(sanitized).not.toContain("I need to inspect");
    expect(sanitized).not.toContain("Wait, I should");
  });

  it("marks CREATED runs as FAILED when execution error handling runs", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      runRepo: {
        create(run: Run): Promise<void>;
        update(run: Run): Promise<void>;
        getById(runId: string): Promise<Run | null>;
      };
      runEventRecorder: {
        recordRunFailed(error: string, totalDurationMs: number): Promise<void>;
      };
      handleExecutionError(runId: string, error: unknown): Promise<void>;
    };
    const callOrder: string[] = [];
    const originalUpdate = privateApi.runRepo.update.bind(privateApi.runRepo);
    const originalRecordRunFailed =
      privateApi.runEventRecorder.recordRunFailed.bind(
        privateApi.runEventRecorder,
      );

    const run = new Run("run-created", "session-1", "CREATED", "coding", {
      agentType: "coding",
      prompt: "check repo",
      sessionId: "session-1",
    });
    await privateApi.runRepo.create(run);
    vi.spyOn(privateApi.runRepo, "update").mockImplementation(
      async (nextRun) => {
        if (nextRun.id === "run-created" && nextRun.status === "FAILED") {
          callOrder.push("update");
        }
        return originalUpdate(nextRun);
      },
    );
    vi.spyOn(privateApi.runEventRecorder, "recordRunFailed").mockImplementation(
      async (error, totalDurationMs) => {
        callOrder.push("failed");
        return originalRecordRunFailed(error, totalDurationMs);
      },
    );

    await privateApi.handleExecutionError("run-created", new Error("boom"));

    const persisted = await privateApi.runRepo.getById("run-created");
    expect(persisted?.status).toBe("FAILED");
    expect(persisted?.metadata.error).toBe("boom");
    expect(callOrder).toEqual(["update", "failed"]);
  });

  it("enforces immutable run manifest for active runs", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
      taskRepo: {
        create(task: {
          id: string;
          runId: string;
          toJSON(): unknown;
        }): Promise<void>;
      };
    };

    await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "run once",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
      },
      TEST_RUN_ID,
      "session-1",
    );

    // Seed a task so the CREATED run is non-idle and manifest is enforced
    const { Task: TaskClass } = await import("../task/index.js");
    const seedTask = new TaskClass(
      "manifest-guard-task",
      TEST_RUN_ID,
      "shell",
      "PENDING",
      [],
      { description: "guard task" },
    );
    await privateApi.taskRepo.create(seedTask);

    await expect(
      privateApi.getOrCreateRun(
        {
          agentType: "coding",
          prompt: "same run id, different provider",
          sessionId: "session-1",
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
        },
        TEST_RUN_ID,
        "session-1",
      ),
    ).rejects.toThrow("Immutable run manifest mismatch");
  });

  it("recycles idle CREATED run with no tasks when selection changes", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
    };

    await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "initial idle run",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
      },
      TEST_RUN_ID,
      "session-1",
    );

    const recycled = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "switch provider while idle",
        sessionId: "session-1",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
      },
      TEST_RUN_ID,
      "session-1",
    );

    expect(recycled.status).toBe("CREATED");
    expect(recycled.input.providerId).toBe("groq");
    expect(recycled.input.modelId).toBe("llama-3.3-70b-versatile");
    expect(recycled.metadata.manifest?.providerId).toBe("groq");
    expect(recycled.metadata.manifest?.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("allows selection changes when existing run is terminal", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
      runRepo: {
        update(run: Run): Promise<void>;
      };
    };

    const initialRun = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "run once",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
      },
      TEST_RUN_ID,
      "session-1",
    );

    initialRun.transition("RUNNING");
    initialRun.transition("COMPLETED");
    await privateApi.runRepo.update(initialRun);

    const resetRun = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "reuse run id with new model",
        sessionId: "session-1",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
      },
      TEST_RUN_ID,
      "session-1",
    );

    expect(resetRun.status).toBe("CREATED");
    expect(resetRun.input.providerId).toBe("groq");
    expect(resetRun.input.modelId).toBe("llama-3.3-70b-versatile");
    expect(resetRun.metadata.manifest?.providerId).toBe("groq");
    expect(resetRun.metadata.manifest?.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("clears prior run events when recycling a terminal run", async () => {
    const state = new MockRuntimeState();
    const runEngine = createRunEngineForRun({ state });
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
      runRepo: {
        update(run: Run): Promise<void>;
      };
      runEventRecorder: {
        recordMessageEmitted(
          role: "user" | "assistant" | "system",
          content: string,
          metadata?: Record<string, unknown>,
        ): Promise<void>;
      };
    };

    const initialRun = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "first run",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
      },
      TEST_RUN_ID,
      "session-1",
    );
    await privateApi.runEventRecorder.recordMessageEmitted(
      "assistant",
      "First run output",
    );
    initialRun.transition("RUNNING");
    initialRun.transition("COMPLETED");
    await privateApi.runRepo.update(initialRun);

    await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "second run",
        sessionId: "session-1",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
      },
      TEST_RUN_ID,
      "session-1",
    );

    const events = await new RunEventRepository(state).getByRun(TEST_RUN_ID);
    expect(events).toHaveLength(0);
  });

  it("restores tasks if recyclable-run reset fails after deleting tasks", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
      runRepo: {
        getById(runId: string): Promise<Run | null>;
        update(run: Run): Promise<void>;
      };
      taskRepo: {
        create(task: {
          id: string;
          runId: string;
          toJSON(): unknown;
        }): Promise<void>;
        getByRun(runId: string): Promise<Array<{ id: string }>>;
      };
    };

    const initialRun = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "initial run",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
      },
      TEST_RUN_ID,
      "session-1",
    );

    const { Task: TaskClass } = await import("../task/index.js");
    const seedTask = new TaskClass(
      "reset-restore-task",
      TEST_RUN_ID,
      "shell",
      "PENDING",
      [],
      { description: "task to restore after failed reset" },
    );
    await privateApi.taskRepo.create(seedTask);

    initialRun.transition("RUNNING");
    initialRun.transition("COMPLETED");
    await privateApi.runRepo.update(initialRun);

    const originalUpdate = privateApi.runRepo.update.bind(privateApi.runRepo);
    const updateSpy = vi
      .spyOn(privateApi.runRepo, "update")
      .mockImplementation(async (run: Run) => {
        if (
          run.id === TEST_RUN_ID &&
          run.status === "CREATED" &&
          run.input.providerId === "groq"
        ) {
          throw new Error("simulated reset update failure");
        }
        await originalUpdate(run);
      });

    await expect(
      privateApi.getOrCreateRun(
        {
          agentType: "coding",
          prompt: "reuse run with new model",
          sessionId: "session-1",
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
        },
        TEST_RUN_ID,
        "session-1",
      ),
    ).rejects.toThrow("simulated reset update failure");

    updateSpy.mockRestore();

    const restoredTasks = await privateApi.taskRepo.getByRun(TEST_RUN_ID);
    expect(restoredTasks).toHaveLength(1);
    expect(restoredTasks[0]?.id).toBe("reset-restore-task");

    const persistedRun = await privateApi.runRepo.getById(TEST_RUN_ID);
    expect(persistedRun?.status).toBe("COMPLETED");
    expect(persistedRun?.input.providerId).toBe("openai");
  });

  it("records immutable selection snapshots for explicit plan runs without execution metadata", async () => {
    const runEngine = createRunEngine({
      llmGateway: createPlanningLLMGateway(),
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        mode: "plan",
        prompt: "implement a tiny command task",
        sessionId: "session-1",
        providerId: "openai",
        modelId: "gpt-4o",
        harnessId: "local-sandbox",
      },
      [{ role: "user", content: "implement a tiny command task" }],
      {},
    );

    expect(response.status).toBe(200);

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);

    const manifest = persisted?.metadata.manifest;
    const snapshots = persisted?.metadata.phaseSelectionSnapshots;
    const lifecycleSteps = persisted?.metadata.lifecycleSteps?.map(
      (entry) => entry.step,
    );
    const telemetry = persisted?.metadata.orchestrationTelemetry;

    expect(manifest).toBeDefined();
    expect(snapshots).toBeDefined();
    expect(snapshots?.planning).toEqual(manifest);
    expect(snapshots?.execution).toBeUndefined();
    expect(snapshots?.synthesis).toEqual(manifest);
    expect(snapshots?.planning).not.toBe(manifest);
    expect(lifecycleSteps).toEqual([
      "RUN_CREATED",
      "CONTEXT_PREPARED",
      "PLAN_VALIDATED",
      "SYNTHESIS",
      "TERMINAL",
    ]);
    expect(telemetry?.wakeupCount).toBe(1);
    expect(telemetry?.resumeCount).toBe(0);
    expect(telemetry?.activeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("applies reviewer pass when reviewer feature flag is enabled", async () => {
    const llmGateway: ILLMGateway = {
      generateText: async () => ({
        text: "Execution complete",
        usage: {
          provider: "mock",
          model: "mock-model",
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
      }),
      generateStructured: async (req) => {
        if (req.context.phase === "planning") {
          return {
            object: {
              tasks: [],
              metadata: { estimatedSteps: 1 },
            },
            usage: {
              provider: "mock",
              model: "mock-model",
              promptTokens: 5,
              completionTokens: 5,
              totalTokens: 10,
            },
          };
        }

        return {
          object: {
            verdict: "request_changes",
            summary: "Improve result precision",
            issues: ["Missing implementation detail"],
          },
          usage: {
            provider: "mock",
            model: "mock-model",
            promptTokens: 5,
            completionTokens: 5,
            totalTokens: 10,
          },
        };
      },
      generateStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const runEngine = createRunEngine({ llmGateway });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "summarize the tiny command task",
        sessionId: "session-1",
        metadata: {
          featureFlags: {
            reviewerPassV1: true,
          },
        },
      },
      [{ role: "user", content: "summarize the tiny command task" }],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain("Reviewer Note (request_changes)");

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);
    expect(persisted?.metadata.reviewerPass?.enabled).toBe(true);
    expect(persisted?.metadata.reviewerPass?.verdict).toBe("request_changes");
  });

  it("tracks wakeups and resumptions for pre-existing active runs", async () => {
    const runEngine = createRunEngine({
      llmGateway: createPlanningLLMGateway(),
    });
    const privateApi = runEngine as unknown as {
      getOrCreateRun(
        input: {
          agentType: "coding";
          prompt: string;
          sessionId: string;
          providerId?: string;
          modelId?: string;
        },
        runId: string,
        sessionId: string,
      ): Promise<Run>;
      runRepo: {
        update(run: Run): Promise<void>;
      };
      taskRepo: {
        create(task: {
          id: string;
          runId: string;
          toJSON(): unknown;
        }): Promise<void>;
      };
      getRun(runId: string): Promise<Run | null>;
    };

    const preexistingRun = await privateApi.getOrCreateRun(
      {
        agentType: "coding",
        prompt: "resume marker",
        sessionId: "session-1",
      },
      TEST_RUN_ID,
      "session-1",
    );
    preexistingRun.metadata.orchestrationTelemetry = {
      activeDurationMs: 10,
      wakeupCount: 1,
      resumeCount: 0,
      lastWakeupAt: new Date(Date.now() - 5_000).toISOString(),
    };
    await privateApi.runRepo.update(preexistingRun);

    // Seed a task so the CREATED run is not considered idle-recyclable
    const { Task: TaskClass } = await import("../task/index.js");
    const seedTask = new TaskClass(
      "seed-task-1",
      TEST_RUN_ID,
      "shell",
      "PENDING",
      [],
      { description: "seed task" },
    );
    await privateApi.taskRepo.create(seedTask);

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "continue with a deterministic plan",
        sessionId: "session-1",
      },
      [{ role: "user", content: "continue with a deterministic plan" }],
      {},
    );

    expect(response.status).toBe(200);

    const persisted = await privateApi.getRun(TEST_RUN_ID);
    expect(persisted?.metadata.orchestrationTelemetry?.wakeupCount).toBe(2);
    expect(persisted?.metadata.orchestrationTelemetry?.resumeCount).toBe(1);
    expect(
      persisted?.metadata.orchestrationTelemetry?.activeDurationMs ?? 0,
    ).toBeGreaterThanOrEqual(10);
  });

  it("maintains isolated lifecycle/telemetry state across a run matrix", async () => {
    const state = new MockRuntimeState();
    const runIds = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    const sessionIds = [
      "session-matrix-a",
      "session-matrix-a",
      "session-matrix-b",
    ];

    const engines = runIds.map((runId, index) =>
      createRunEngineForRun({
        state,
        runId,
        sessionId: sessionIds[index] ?? "session-matrix-a",
      }),
    );

    await Promise.all(
      engines.map((engine, index) =>
        engine.execute(
          {
            agentType: "coding",
            prompt: `hey from run ${index + 1}`,
            sessionId: sessionIds[index] ?? "session-matrix-a",
          },
          [{ role: "user", content: `hey from run ${index + 1}` }],
          {},
        ),
      ),
    );

    const runs = await Promise.all(
      engines.map((engine, index) => engine.getRun(runIds[index]!)),
    );
    const manifests = runs.map((run) => run?.metadata.manifest);
    const lifecycles = runs.map((run) =>
      run?.metadata.lifecycleSteps?.map((step) => step.step),
    );
    const wakeups = runs.map(
      (run) => run?.metadata.orchestrationTelemetry?.wakeupCount ?? 0,
    );

    expect(new Set(runs.map((run) => run?.id)).size).toBe(3);
    expect(new Set(runs.map((run) => run?.sessionId)).size).toBe(2);
    expect(manifests.every((manifest) => manifest !== undefined)).toBe(true);
    expect(lifecycles.every((steps) => steps?.includes("RUN_CREATED"))).toBe(
      true,
    );
    expect(wakeups).toEqual([1, 1, 1]);
  });

  it("returns a clear auth message when workspace bootstrap needs authorization", async () => {
    const runEngine = createRunEngine({
      workspaceBootstrapper: {
        bootstrap: async () => ({ status: "needs-auth" }),
      },
    });
    const privateApi = runEngine as unknown as {
      getWorkspaceBootstrapMessage(
        runId: string,
        prompt: string,
        repositoryContext?: { owner?: string; repo?: string; branch?: string },
      ): Promise<string | null>;
    };

    const message = await privateApi.getWorkspaceBootstrapMessage(
      "run-1",
      "check the repository status",
      {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    );

    expect(message).toContain("GitHub authorization");
  });

  it("records expected bootstrap misses separately from generic failures", async () => {
    const runEngine = createRunEngine({
      workspaceBootstrapper: {
        bootstrap: async () => ({
          status: "sync-failed",
          message: "fatal: not a git repository",
        }),
      },
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "check git status",
        sessionId: "session-1",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
          branch: "main",
        },
      },
      [{ role: "user", content: "check git status" }],
      {},
    );

    expect(response.status).toBe(200);
    const persisted = await runEngine.getRun(TEST_RUN_ID);
    expect(persisted?.metadata.workspaceBootstrap).toMatchObject({
      requested: true,
      ready: false,
      status: "sync-failed",
      blocked: true,
      expectedMiss: true,
    });
  });

  it("blocks cross-repo actions until explicit approval is recorded", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getPermissionPolicyMessage(
        prompt: string,
        repositoryContext?: { owner?: string; repo?: string },
      ): Promise<string | null>;
      processPermissionDirectives(prompt: string): Promise<string | null>;
    };

    const blockedMessage = await privateApi.getPermissionPolicyMessage(
      "check repository acme/platform-core README.md",
      { owner: "sourcegraph", repo: "shadowbox" },
    );
    expect(blockedMessage).toContain(
      "Cross-repo access requires explicit approval",
    );

    const directiveMessage = await privateApi.processPermissionDirectives(
      "approve cross-repo acme/platform-core for 20m",
    );
    expect(directiveMessage).toContain("Cross-repo access approved");

    const allowedMessage = await privateApi.getPermissionPolicyMessage(
      "check repository acme/platform-core README.md",
      { owner: "sourcegraph", repo: "shadowbox" },
    );
    expect(allowedMessage).toBeNull();
  });

  it("blocks destructive operations until explicit approval is recorded", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getPermissionPolicyMessage(
        prompt: string,
        repositoryContext?: { owner?: string; repo?: string },
      ): Promise<string | null>;
      processPermissionDirectives(prompt: string): Promise<string | null>;
    };

    const blockedMessage = await privateApi.getPermissionPolicyMessage(
      "run git reset --hard HEAD~1",
      { owner: "sourcegraph", repo: "shadowbox" },
    );
    expect(blockedMessage).toContain("approve destructive");

    const directiveMessage = await privateApi.processPermissionDirectives(
      "approve destructive for 15m",
    );
    expect(directiveMessage).toContain("Destructive-action approval granted");

    const allowedMessage = await privateApi.getPermissionPolicyMessage(
      "run git reset --hard HEAD~1",
      { owner: "sourcegraph", repo: "shadowbox" },
    );
    expect(allowedMessage).toBeNull();
  });

  it("does not grant approvals from embedded directives in non-approval prompts", async () => {
    const runEngine = createRunEngine();
    const privateApi = runEngine as unknown as {
      getPermissionPolicyMessage(
        prompt: string,
        repositoryContext?: { owner?: string; repo?: string },
      ): Promise<string | null>;
      processPermissionDirectives(prompt: string): Promise<string | null>;
    };

    const directiveMessage = await privateApi.processPermissionDirectives(
      "Please check repository acme/platform-core and approve cross-repo acme/platform-core for 20m",
    );
    expect(directiveMessage).toBeNull();

    const blockedMessage = await privateApi.getPermissionPolicyMessage(
      "check repository acme/platform-core README.md",
      { owner: "sourcegraph", repo: "shadowbox" },
    );
    expect(blockedMessage).toContain(
      "Cross-repo access requires explicit approval",
    );
  });

  it("forces platform approval gate when delegated harness mode is untrusted", async () => {
    const runEngine = createRunEngine({
      llmGateway: createPlanningLLMGateway(),
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "check repository acme/platform-core README.md",
        sessionId: "session-1",
        harnessMode: "delegated",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
        },
      },
      [
        {
          role: "user",
          content: "check repository acme/platform-core README.md",
        },
      ],
      {},
    );

    expect(response.status).toBe(200);
    const output = await response.text();

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);

    const lifecycleSteps = persisted?.metadata.lifecycleSteps?.map(
      (entry) => entry.step,
    );

    expect(lifecycleSteps).toContain("APPROVAL_WAIT");
    expect(persisted?.metadata.manifest?.harnessMode).toBe("platform_owned");
    expect(output).toContain("Cross-repo access requires explicit approval");
    expect(persisted?.status).toBe("COMPLETED");
  });

  it("skips platform approval gate when delegated mode is internally authorized", async () => {
    const runEngine = createRunEngine({
      llmGateway: createPlanningLLMGateway(),
    });

    const response = await runEngine.execute(
      {
        agentType: "coding",
        prompt: "check repository acme/platform-core README.md",
        sessionId: "session-1",
        harnessMode: "delegated",
        metadata: {
          internal: { allowDelegatedHarnessMode: true },
        },
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
        },
      },
      [
        {
          role: "user",
          content: "check repository acme/platform-core README.md",
        },
      ],
      {},
    );

    expect(response.status).toBe(200);

    const persisted = await (
      runEngine as unknown as {
        getRun(runId: string): Promise<Run | null>;
      }
    ).getRun(TEST_RUN_ID);

    const lifecycleSteps = persisted?.metadata.lifecycleSteps?.map(
      (entry) => entry.step,
    );

    expect(lifecycleSteps).not.toContain("APPROVAL_WAIT");
    expect(persisted?.metadata.manifest?.harnessMode).toBe("delegated");
    expect(persisted?.status).toBe("COMPLETED");
  });
});

function createRunEngine(
  dependencies: Partial<RunEngineDependencies> = {},
): RunEngine {
  return createRunEngineForRun({ dependencies });
}

function createRunEngineForRun({
  state = new MockRuntimeState(),
  runId = TEST_RUN_ID,
  sessionId = "session-1",
  dependencies = {},
}: {
  state?: RuntimeDurableObjectState;
  runId?: string;
  sessionId?: string;
  dependencies?: Partial<RunEngineDependencies>;
} = {}): RunEngine {
  const llmGateway = dependencies.llmGateway ?? createMockLLMGateway();
  return new RunEngine(
    state,
    {
      env: { NODE_ENV: "test" } as unknown,
      sessionId,
      runId,
    },
    undefined,
    undefined,
    { ...dependencies, llmGateway },
  );
}

function createMockLLMGateway(): ILLMGateway {
  return {
    generateText: async () => ({
      text: "ok",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }),
    generateStructured: async () => ({
      object: { tasks: [], metadata: { estimatedSteps: 1 } },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }),
    generateStream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
  };
}

function createPlanningLLMGateway(): ILLMGateway {
  return {
    generateText: async () => ({
      text: "Execution complete",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
      },
    }),
    generateStructured: async () => ({
      object: {
        tasks: [
          {
            id: "task-1",
            type: "shell",
            description: "Echo a deterministic marker",
            dependsOn: [],
            input: { command: "echo done" },
          },
        ],
        metadata: { estimatedSteps: 1 },
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
      },
    }),
    generateStream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
  };
}

class InMemoryStorage implements RuntimeStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.store.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.store.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    const prefix = options?.prefix;
    const start = options?.start;
    const end = options?.end;
    const limit = options?.limit;

    for (const [key, value] of this.store.entries()) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }
      if (start && key < start) {
        continue;
      }
      if (end && key >= end) {
        continue;
      }

      output.set(key, value as T);
      if (typeof limit === "number" && output.size >= limit) {
        break;
      }
    }

    return output;
  }
}

class MockRuntimeState implements RuntimeDurableObjectState {
  storage: RuntimeStorage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await closure();
  }
}
