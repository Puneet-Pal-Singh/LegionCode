import {
  ItemIdSchema,
  LifecycleTransitionError,
  RunAttemptIdSchema,
  ToolCallIdSchema,
  TurnSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeKernelError,
  RuntimeLifecycleSettlementError,
} from "./errors.js";
import type {
  RuntimeHookOrchestrationPort,
  ContextCompactionPort,
  RuntimeLifecycleEventStore,
} from "./ports.js";
import { RuntimeKernel } from "./RuntimeKernel.js";
import type { ApprovalResolution } from "./types.js";
import {
  MemoryLifecycleEventSink,
  approvalRequest,
  createLifecycleSink,
  createArtifactPorts,
  createManifestRepository,
  createPorts,
  finalItemId,
  manifest,
  run,
  runAttemptId,
  timestamp,
  turn,
} from "./test-fixtures.js";

describe("RuntimeKernel canonical lifecycle", () => {
  it("runs distinct session and prompt hooks through the canonical audit appender before the provider", async () => {
    const sink = createLifecycleSink();
    const order: string[] = [];
    const triggerIds: string[] = [];
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      order.push("provider");
      return {
        kind: "complete" as const,
        itemId: finalItemId,
        output: "Done",
      };
    });
    const hooks: RuntimeHookOrchestrationPort = {
      async runSessionStart(input): Promise<void> {
        order.push("session");
        triggerIds.push(input.triggerEventId);
        await input.auditAppender.appendHookAudit("hook.invocation.started", {
          eventName: "SessionStart",
        });
      },
      async runUserPromptSubmit(input): Promise<void> {
        order.push("prompt");
        triggerIds.push(input.triggerEventId);
        await input.auditAppender.appendHookAudit("hook.invocation.completed", {
          eventName: "UserPromptSubmit",
        });
      },
    };
    const kernel = await createKernel(
      sink,
      ports,
      createArtifactPorts(),
      hooks,
    );

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(order).toEqual(["session", "prompt", "provider"]);
    expect(triggerIds).toEqual([
      sink.events.find((event) => event.type === "turn.started")?.eventId,
      sink.events.find((event) => event.type === "run_attempt.started")
        ?.eventId,
    ]);
    expect(eventTypes(sink).slice(0, 6)).toEqual([
      "turn.queued",
      "turn.started",
      "run_attempt.started",
      "workspace.snapshot_captured",
      "hook.invocation.started",
      "hook.invocation.completed",
    ]);
  });

  it("settles a provider-only turn exactly once with the terminal event last", async () => {
    const sink = createLifecycleSink();
    const kernel = await createKernel(sink);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).resolves.toEqual({
      status: "completed",
      output: "Done",
      toolCallCount: 0,
      workspace: manifest,
    });

    expect(eventTypes(sink)).toEqual([
      "turn.queued",
      "turn.started",
      "run_attempt.started",
      "workspace.snapshot_captured",
      "workspace.snapshot_captured",
      "turn.diff_updated",
      "artifact.created",
      "item.started",
      "assistant_message.delta",
      "item.completed",
      "run_attempt.succeeded",
      "turn.completed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);

    const readOnlySink = createLifecycleSink();
    const readOnlyPorts = createPorts();
    const restrictedWorker = { ...readOnlyPorts.worker, executionCapability: "read_only" as const };
    const readOnly = new RuntimeKernel({
      lifecycleEvents: readOnlySink, ...readOnlyPorts, worker: restrictedWorker,
      workspaceManifests: await createManifestRepository(), artifactCapture: "omitted_read_only",
      producerId: "local-read-only-test",
    });
    await expect(readOnly.startTurn({ run: { ...run, mode: "ask" }, turn, runAttemptId })).resolves.toMatchObject({ output: "Done" });
    expect(terminalEvents(readOnlySink)).toHaveLength(1);
    expect(eventTypes(readOnlySink)).not.toContain("workspace.snapshot_captured");
    expect(eventTypes(readOnlySink)).not.toContain("turn.diff_updated");
    expect(eventTypes(readOnlySink)).not.toContain("artifact.created");
    for (const variant of [
      { mode: "auto_edit" as const, worker: restrictedWorker },
      { mode: "ask" as const, worker: readOnlyPorts.worker },
      { mode: "ask" as const, worker: restrictedWorker, hooks: { runSessionStart: async () => {}, runUserPromptSubmit: async () => {} } },
    ]) {
      const rejectedSink = createLifecycleSink();
      const deniedCapture = new RuntimeKernel({
        lifecycleEvents: rejectedSink, ...readOnlyPorts,
        workspaceManifests: await createManifestRepository(), artifactCapture: "omitted_read_only",
        producerId: "local-read-only-test", worker: variant.worker, hooks: variant.hooks,
      });
      await expect(deniedCapture.startTurn({ run: { ...run, mode: variant.mode }, turn, runAttemptId })).rejects.toMatchObject({ code: "tool_policy_denied" });
      expect(terminalEvents(rejectedSink)).toHaveLength(1);
      expect(readOnlyPorts.worker.executeTool).not.toHaveBeenCalled();
    }
    const missingCapture = new RuntimeKernel({
      lifecycleEvents: createLifecycleSink(), ...createPorts(), workspaceManifests: await createManifestRepository(), producerId: "default-capture-test",
    });
    await expect(missingCapture.startTurn({ run, turn, runAttemptId })).rejects.toMatchObject({ code: "turn_artifact_settlement_failed" });
    const revokedSink = createLifecycleSink();
    const revoked = new RuntimeKernel({
      lifecycleEvents: revokedSink, ...readOnlyPorts, worker: restrictedWorker,
      artifactCapture: "omitted_read_only", producerId: "revoked-test",
    });
    await expect(revoked.startTurn({ run: { ...run, mode: "ask" }, turn, runAttemptId })).rejects.toMatchObject({ code: "workspace_not_found" });
    expect(terminalEvents(revokedSink)).toHaveLength(1);
    expect(revokedSink.events.at(-1)?.type).toBe("turn.failed");

    const conversationSink = createLifecycleSink();
    const ports = createPorts();
    const forbiddenArtifacts = createArtifactPorts();
    const conversation = new RuntimeKernel({
      lifecycleEvents: conversationSink, ...ports, ...forbiddenArtifacts,
      producerId: "conversation-test", clock: { now: () => timestamp },
    });
    const result = await conversation.startTurn({ run: { ...run, executionCapability: "conversation" }, turn, runAttemptId });
    expect(result.workspace).toBeNull();
    expect(result.output).toBe("Done");
    expect(eventTypes(conversationSink)).not.toContain("workspace.snapshot_captured");
    expect(eventTypes(conversationSink)).not.toContain("turn.diff_updated");
    expect(conversationSink.events.find((event) => event.type === "run_attempt.started")?.payload).toMatchObject({ executionCapability: "conversation" });
    expect(conversationSink.events.at(-1)?.type).toBe("turn.completed");
    expect(forbiddenArtifacts.gitSnapshots.captureSnapshot).not.toHaveBeenCalled();
    expect(ports.worker.executeTool).not.toHaveBeenCalled();

    const deniedSink = createLifecycleSink();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    const denied = new RuntimeKernel({ lifecycleEvents: deniedSink, ...ports, producerId: "conversation-test" });
    await expect(denied.startTurn({ run: { ...run, executionCapability: "conversation" }, turn, runAttemptId })).rejects.toMatchObject({ code: "tool_policy_denied" });
    expect(ports.worker.executeTool).not.toHaveBeenCalled();
    expect(terminalEvents(deniedSink)).toHaveLength(1);
    expect(deniedSink.events.at(-1)?.type).toBe("turn.failed");
  });

  it("emits long final answers as schema-bounded deltas without truncation", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    const output = "x".repeat(8_137);
    ports.provider.generateNext = vi.fn(async () => ({
      kind: "complete" as const,
      itemId: finalItemId,
      output,
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).resolves.toMatchObject({
      status: "completed",
      output,
    });

    const deltas = sink.events.flatMap((event) =>
      event.type === "assistant_message.delta" &&
      typeof event.payload.delta === "string"
        ? [event.payload.delta]
        : [],
    );
    expect(deltas.map((delta) => delta.length)).toEqual([4_000, 4_000, 137]);
    expect(deltas.join("")).toBe(output);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("settles provider failures with a replayable sanitized reason", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new Error("Provider route rejected Bearer CANARY_PROVIDER_TOKEN apiKey=AIza_CANARY_KEY /home/CANARY/.codex/auth.json");
    });
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "Provider route rejected",
    );

    const failed = sink.events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toMatchObject({
      outcome: {
        failure: {
          code: "provider_unavailable",
          message: "The model provider request failed.",
        },
      },
    });
    expect(JSON.stringify(sink.events)).not.toContain("CANARY");
  });

  it("does not expose raw provider quota diagnostics in failed-turn output", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "Quota exceeded for generativelanguage.googleapis.com/generate_content_free_tier_input_token_count; retry in 49s",
        ),
        { statusCode: 429 },
      );
    });
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "Quota exceeded",
    );

    const failed = sink.events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toMatchObject({
      outcome: {
        failure: {
          code: "rate_limited",
          message: expect.stringContaining("temporarily rate limited"),
        },
      },
    });
    expect(JSON.stringify(failed?.payload)).not.toContain(
      "generate_content_free_tier_input_token_count",
    );
  });

  it("automatically compacts once at the model-aware threshold and replays its settlement", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.contextAssembly.assemble = vi.fn(async () => ({
      instructions: "Implement the requested change",
      metadata: {},
      budgetSnapshot: {
        providerId: "openai",
        modelId: "gpt-5",
        contextWindowLimit: 100,
        systemTokens: 10,
        conversationTokens: 55,
        toolDefinitionTokens: 5,
        attachmentTokens: null,
        repositoryContextTokens: null,
        reservedOutputTokens: 20,
        safetyReserveTokens: 10,
        effectiveInputBudget: 70,
        tokensUsed: 65,
        tokensRemaining: 5,
        utilizationPercent: 92.85,
        warningThresholdPercent: 70,
        automaticCompactionThresholdPercent: 80,
        measurementSource: "tokenizer" as const,
      },
    }));
    const compaction: ContextCompactionPort = {
      compact: vi.fn(async ({ context }) => ({
        context: {
          ...context,
          budgetSnapshot: {
            ...context.budgetSnapshot!,
            tokensUsed: 10,
            tokensRemaining: 60,
            utilizationPercent: 14.28,
          },
        },
        preservedContextReference: "context:trn_runtime001:compacted",
        summary: "Preserved request and tool outcomes.",
      })),
    };
    const kernel = await createKernel(
      sink,
      ports,
      createArtifactPorts(),
      undefined,
      compaction,
    );

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(compaction.compact).toHaveBeenCalledTimes(1);
    expect(eventTypes(sink)).toContain("context_compaction.requested");
    expect(eventTypes(sink)).toContain("context_compaction.completed");
    expect(
      eventTypes(sink).filter(
        (type) => type === "context_compaction.completed",
      ),
    ).toHaveLength(1);
  });

  it("settles failed tool work before the explicit failed turn outcome", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "failed" as const,
      failure: protocolFailure("Write failed"),
      disposition: "terminal" as const,
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toMatchObject({
      code: "worker_failed",
    });

    expect(eventTypes(sink).slice(-7)).toEqual([
      "tool_call.failed",
      "item.failed",
      "workspace.snapshot_captured",
      "turn.diff_updated",
      "artifact.created",
      "run_attempt.failed",
      "turn.failed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("persists one terminal sandbox infrastructure failure without provider relabeling", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "failed" as const,
      disposition: "terminal" as const,
      failure: {
        code: "worker_unavailable" as const,
        message: "Sandbox container became unavailable Bearer CANARY_WORKER_TOKEN",
        retryable: true,
        correlationId: "CANARY_UPSTREAM_CORRELATION",
        details: {
          secureStatus: "sandbox_unavailable",
          secureCode: "SANDBOX_UNAVAILABLE",
          taskId: "CANARY_PRIVATE_TASK",
          leaseId: "lease-1",
        },
      },
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toMatchObject({ code: "worker_failed" });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: {
        outcome: {
          failure: {
            code: "worker_unavailable",
            retryable: true,
            correlationId: null,
            details: null,
          },
        },
      },
    });
    expect(JSON.stringify(sink.events)).not.toContain("provider_unavailable");
    expect(JSON.stringify(sink.events)).not.toContain("CANARY");
  });

  it("returns a recoverable tool failure to the provider loop before completing", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockImplementationOnce(async ({ toolResults }) => {
        expect(JSON.stringify(toolResults)).not.toContain("CANARY");
        expect(toolResults).toEqual([
          expect.objectContaining({
            toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
            failure: expect.objectContaining({
              code: "not_found",
              message: "The requested resource was not found.",
            }),
          }),
        ]);
        return {
          kind: "complete" as const,
          itemId: finalItemId,
          output: "I could not read that path, but the turn continued.",
        };
      });
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "failed" as const,
      disposition: "recoverable" as const,
      failure: {
        code: "not_found" as const,
        message: "README.missing was not found Bearer CANARY_RECOVERABLE_TOKEN",
        retryable: false,
        correlationId: null,
        details: null,
      },
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).resolves.toMatchObject({
      status: "completed",
      output: "I could not read that path, but the turn continued.",
      toolCallCount: 1,
    });

    expect(eventTypes(sink)).toContain("tool_call.failed");
    expect(JSON.stringify(sink.events)).not.toContain("CANARY");
    expect(eventTypes(sink)).toContain("item.failed");
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("starts tool lifecycle with the canonical display enriched by authorization", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete" as const,
        itemId: finalItemId,
        output: "Done",
      });
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "authorized" as const,
      toolCall: {
        ...toolCall,
        display: {
          title: "Edit file",
          family: "edit" as const,
          namespace: "write_file",
          inputSummary: "src/index.ts",
        },
      },
    }));
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(
      sink.events.find((event) => event.type === "tool_call.started")?.payload,
    ).toEqual({
      toolName: "write_file",
      display: {
        title: "Edit file",
        family: "edit",
        namespace: "write_file",
        inputSummary: "src/index.ts",
      },
    });
  });

  it("persists provider commentary before the canonical child tool lifecycle", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        ...toolStep(),
        commentary: "I’ll inspect the file first.",
      })
      .mockResolvedValueOnce({
        kind: "complete" as const,
        itemId: finalItemId,
        output: "Done",
      });
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    const commentaryDeltaIndex = sink.events.findIndex(
      (event) =>
        event.type === "assistant_message.delta" &&
        event.payload.phase === "commentary",
    );
    const toolStartedIndex = sink.events.findIndex(
      (event) => event.type === "tool_call.started",
    );

    expect(commentaryDeltaIndex).toBeGreaterThan(0);
    expect(toolStartedIndex).toBeGreaterThan(commentaryDeltaIndex);
    expect(sink.events[commentaryDeltaIndex - 1]?.type).toBe("item.started");
    expect(sink.events[commentaryDeltaIndex + 1]?.type).toBe("item.completed");
    expect(sink.events[commentaryDeltaIndex]).toMatchObject({
      itemId: "itm_runtime001_commentary_0",
      payload: {
        phase: "commentary",
        delta: "I’ll inspect the file first.",
      },
    });
  });

  it("emits only provider-designated safe reasoning summaries", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        ...toolStep(),
        reasoning: { text: "Safe provider summary", displaySafe: true },
      })
      .mockResolvedValueOnce({
        kind: "complete" as const,
        itemId: finalItemId,
        output: "Done",
      });
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(
      sink.events.filter((event) => event.type === "reasoning.summary_delta"),
    ).toHaveLength(1);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: "reasoning.summary_delta",
        itemId: "itm_runtime001_reasoning_0",
        payload: { delta: "Safe provider summary", displaySafe: true },
      }),
    );

    const hiddenSink = createLifecycleSink();
    const hiddenPorts = createPorts();
    hiddenPorts.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce({
        ...toolStep(),
        reasoning: { text: "Private chain of thought", displaySafe: false },
      })
      .mockResolvedValueOnce({
        kind: "complete" as const,
        itemId: finalItemId,
        output: "Done",
      });
    await (
      await createKernel(hiddenSink, hiddenPorts)
    ).startTurn({
      run,
      turn,
      runAttemptId,
    });
    expect(
      hiddenSink.events.some(
        (event) =>
          event.type === "reasoning.summary_delta" ||
          JSON.stringify(event.payload).includes("Private chain of thought"),
      ),
    ).toBe(false);
  });

  it("emits approval lifecycle events before policy-gated execution", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "approval_required" as const,
      toolCall,
      request: approvalRequest,
    }));
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(ports.worker.executeTool).toHaveBeenCalledTimes(1);
    expect(ports.worker.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: expect.objectContaining({ decision: "approved" }),
      }),
    );
    expect(eventTypes(sink)).toContain("approval.requested");
    expect(eventTypes(sink)).toContain("approval.decided");
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
  });

  it("settles an externally delivered approval once and resumes the waiting turn", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "approval_required" as const,
      toolCall,
      request: approvalRequest,
    }));
    ports.approvals.waitForDecision = vi.fn(() => new Promise(() => undefined));
    const kernel = await createKernel(sink, ports);

    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await vi.waitFor(() => {
      expect(eventTypes(sink)).toContain("approval.requested");
    });

    await kernel.resolveApproval(turn.id, approvalRequest.approvalId, {
      decision: "approved",
      decidedBy: run.userId,
      reason: null,
      grantScope: "matching_in_chat",
    });

    await expect(execution).resolves.toMatchObject({ status: "completed" });
    expect(
      eventTypes(sink).filter((type) => type === "approval.decided"),
    ).toHaveLength(1);
    expect(
      sink.events.find((event) => event.type === "approval.decided")?.payload,
    ).toMatchObject({ status: "approved", grantScope: "matching_in_chat" });
    await expect(
      kernel.resolveApproval(turn.id, approvalRequest.approvalId, {
        decision: "approved",
        decidedBy: run.userId,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "turn_not_active" });

    const failingSink = createLifecycleSink();
    const failure = new Error("Approval append failed");
    const appendBatch = failingSink.appendBatch.bind(failingSink);
    let rejectFirstDecision = true;
    vi.spyOn(failingSink, "appendBatch").mockImplementation(async (events) => {
      if (
        rejectFirstDecision &&
        events.some((event) => event.type === "approval.decided")
      ) {
        rejectFirstDecision = false;
        throw failure;
      }
      return appendBatch(events);
    });
    const failingPorts = createPorts();
    failingPorts.provider.generateNext = vi.fn(async () => toolStep());
    failingPorts.toolAuthorization.authorize =
      ports.toolAuthorization.authorize;
    failingPorts.approvals.waitForDecision = vi.fn(
      () => new Promise(() => undefined),
    );
    const failingKernel = await createKernel(failingSink, failingPorts);
    const failedExecution = failingKernel.startTurn({
      run,
      turn,
      runAttemptId,
    });
    // Attach immediately: failure must reject the active turn, not strand its wait.
    const executionFailure = expect(failedExecution).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(failingPorts.approvals.waitForDecision).toHaveBeenCalledOnce(),
    );
    await expect(
      failingKernel.resolveApproval(turn.id, approvalRequest.approvalId, {
        decision: "approved",
        decidedBy: run.userId,
        reason: null,
      }),
    ).rejects.toBe(failure);
    await executionFailure;
    expect(failingPorts.worker.executeTool).not.toHaveBeenCalled();
    expect(terminalEvents(failingSink).map((event) => event.type)).toEqual([
      "turn.failed",
    ]);
    expect(
      failingSink.events.filter(
        (event) =>
          event.type === "approval.decided" &&
          event.payload.status === "approved",
      ),
    ).toHaveLength(0);
  });

  it("rejects a reusable scope that the pending approval did not offer", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "approval_required" as const,
      toolCall,
      request: {
        ...approvalRequest,
        options: approvalRequest.options.filter(
          (option) => option.id !== "allow_matching_in_chat",
        ),
      },
    }));
    ports.approvals.waitForDecision = vi.fn(() => new Promise(() => undefined));
    const kernel = await createKernel(sink, ports);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await vi.waitFor(() => {
      expect(eventTypes(sink)).toContain("approval.requested");
    });

    await expect(
      kernel.resolveApproval(turn.id, approvalRequest.approvalId, {
        decision: "approved",
        decidedBy: run.userId,
        reason: null,
        grantScope: "matching_in_chat",
      }),
    ).rejects.toMatchObject({ code: "invalid_approval_grant_scope" });
    await kernel.resolveApproval(turn.id, approvalRequest.approvalId, {
      decision: "approved",
      decidedBy: run.userId,
      reason: null,
    });
    await expect(execution).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps approval timeout distinct from an explicit user denial", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "approval_required" as const,
      toolCall,
      request: approvalRequest,
    }));
    ports.approvals.waitForDecision = vi.fn(async () => ({
      decision: "denied" as const,
      decidedBy: null,
      reason: "Approval timed out before a decision was recorded.",
      timedOut: true,
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toMatchObject({
      code: "approval_timed_out",
      message: expect.stringContaining("timed out"),
    });

    expect(eventTypes(sink)).toContain("approval.decided");
    expect(
      sink.events.find((event) => event.type === "approval.decided")?.payload,
    ).toMatchObject({ status: "timed_out" });
    expect(eventTypes(sink)).toContain("tool_call.failed");
    expect(eventTypes(sink)).not.toContain("tool_call.declined");
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("keeps an explicit approval denial as approval_denied", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete" as const,
        itemId: finalItemId,
        output: "I will continue with a permitted approach.",
      });
    ports.toolAuthorization.authorize = vi.fn(async ({ toolCall }) => ({
      status: "approval_required" as const,
      toolCall,
      request: approvalRequest,
    }));
    let deliverCompetingDecision!: (resolution: ApprovalResolution) => void;
    ports.approvals.waitForDecision = vi.fn(
      () =>
        new Promise<ApprovalResolution>((resolve) => {
          deliverCompetingDecision = resolve;
        }),
    );
    let releaseDecision!: () => void;
    let decisionStarted!: () => void;
    const decisionBlocked = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const decisionAppending = new Promise<void>((resolve) => {
      decisionStarted = resolve;
    });
    const appendBatch = sink.appendBatch.bind(sink);
    vi.spyOn(sink, "appendBatch").mockImplementation(async (events) => {
      if (events.some((event) => event.type === "approval.decided")) {
        decisionStarted();
        await decisionBlocked;
      }
      return appendBatch(events);
    });
    const kernel = await createKernel(sink, ports);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await vi.waitFor(() =>
      expect(ports.approvals.waitForDecision).toHaveBeenCalledOnce(),
    );
    const denied: ApprovalResolution = {
      decision: "denied",
      decidedBy: run.userId,
      reason: "Denied by user.",
    };
    const submitted = { ...denied };
    const winningDecision = kernel.resolveApproval(
      turn.id,
      approvalRequest.approvalId,
      submitted,
    );
    // Caller mutation cannot change the already claimed canonical decision.
    submitted.decision = "approved";
    await decisionAppending;
    const competitors = Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        kernel.resolveApproval(turn.id, approvalRequest.approvalId, {
          ...denied,
          decision: index % 2 === 0 ? "approved" : "denied",
        }),
      ),
    );
    deliverCompetingDecision({ ...denied, decision: "approved" });
    await Promise.resolve();
    expect(ports.worker.executeTool).not.toHaveBeenCalled();
    releaseDecision();
    await winningDecision;
    const outcomes = await competitors;
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(16);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(16);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({
          code: "approval_already_active",
        });
    }
    await expect(execution).resolves.toMatchObject({
      status: "completed",
      output: "I will continue with a permitted approach.",
    });
    expect(
      sink.events.find((event) => event.type === "approval.decided")?.payload,
    ).toMatchObject({ status: "denied" });

    expect(ports.worker.executeTool).not.toHaveBeenCalled();
    expect(ports.provider.generateNext).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolResults: [
          expect.objectContaining({
            toolCallId: expect.any(String),
            output: {
              error: expect.objectContaining({
                code: "policy_denied",
                message: expect.stringContaining(
                  "Do not repeat it or bypass the permission policy",
                ),
                retryable: false,
              }),
            },
            failure: expect.objectContaining({
              code: "policy_denied",
              retryable: false,
            }),
          }),
        ],
      }),
    );
    expect(
      eventTypes(sink).filter((type) => type === "approval.decided"),
    ).toHaveLength(1);
    expect(eventTypes(sink)).toContain("tool_call.declined");
    expect(eventTypes(sink)).not.toContain("tool_call.failed");
    expect(terminalEvents(sink).map((event) => event.type)).toEqual([
      "turn.completed",
    ]);
  });

  it("settles typed policy denial without calling the worker", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.toolAuthorization.authorize = vi.fn(async () => ({
      status: "rejected" as const,
      code: "tool_policy_denied" as const,
      reason: "Read-only runs cannot write files.",
    }));
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toMatchObject({
      code: "tool_policy_denied",
    });

    expect(ports.worker.executeTool).not.toHaveBeenCalled();
    expect(eventTypes(sink).slice(-7)).toEqual([
      "tool_call.failed",
      "item.failed",
      "workspace.snapshot_captured",
      "turn.diff_updated",
      "artifact.created",
      "run_attempt.failed",
      "turn.failed",
    ]);
    expect(sink.events.at(-1)?.payload).toMatchObject({
      outcome: {
        failure: {
          code: "policy_denied",
          details: null,
        },
      },
    });
  });

  it("emits canonical tool output and settles its item before completion", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    ports.worker.executeTool = vi.fn(async () => ({
      kind: "completed" as const,
      output: { stdout: "tests passed" },
    }));
    const kernel = await createKernel(sink, ports);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(eventTypes(sink)).toContain("tool_call.output_delta");
    expect(eventTypes(sink).indexOf("item.completed")).toBeGreaterThan(
      eventTypes(sink).indexOf("tool_call.completed"),
    );
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
  });

  it("retries a transient terminal append without duplicating settlement", async () => {
    const sink = new FailingCompletedSettlementSink(1);
    const kernel = await createKernel(sink);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).resolves.toMatchObject({
      status: "completed",
    });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)?.type).toBe("turn.completed");
  });

  it("recovers exhausted completion settlement as one failed outcome", async () => {
    const sink = new FailingCompletedSettlementSink(2);
    const kernel = await createKernel(sink);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toBeInstanceOf(RuntimeLifecycleSettlementError);

    expect(eventTypes(sink).slice(-2)).toEqual([
      "run_attempt.failed",
      "turn.failed",
    ]);
    expect(terminalEvents(sink)).toHaveLength(1);
  });

  it("rejects a second runtime owner for an accepted turn", async () => {
    const artifacts = createArtifactPorts();
    const kernel = await createKernel(
      createLifecycleSink(),
      createPorts(),
      artifacts,
    );
    await kernel.startTurn({ run, turn, runAttemptId });
    vi.mocked(artifacts.gitSnapshots.captureSnapshot).mockClear();
    vi.mocked(artifacts.turnArtifacts.putSnapshot).mockClear();

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeKernelError>>({
        code: "turn_already_owned",
      }),
    );
    expect(artifacts.gitSnapshots.captureSnapshot).not.toHaveBeenCalled();
    expect(artifacts.turnArtifacts.putSnapshot).not.toHaveBeenCalled();
  });

  it("does not duplicate terminal events when a new kernel retries the turn", async () => {
    const sink = createLifecycleSink();
    await (await createKernel(sink)).startTurn({ run, turn, runAttemptId });

    await (await createKernel(sink)).startTurn({ run, turn, runAttemptId });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events).toHaveLength(12);
  });

  it("settles provider disconnect as failure rather than completion", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new Error("stream disconnected");
    });
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "stream disconnected",
    );

    expect(sink.events.at(-1)?.type).toBe("turn.failed");
    expect(terminalEvents(sink)).toHaveLength(1);
    expect(eventTypes(sink)).not.toContain("turn.completed");
  });

  it("settles provider timeout as one failed terminal outcome", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new Error("provider timed out");
    });
    const kernel = await createKernel(sink, ports);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "provider timed out",
    );

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)?.type).toBe("turn.failed");
  });

  it("settles typed cancellation as one interrupted terminal outcome", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new RuntimeKernelError("turn_cancelled", "Run cancelled Bearer CANARY_CANCEL_TOKEN");
    });
    const kernel = await createKernel(sink, ports);

    await expect(
      kernel.startTurn({ run, turn, runAttemptId }),
    ).rejects.toMatchObject({
      code: "turn_cancelled",
    });

    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)?.type).toBe("turn.interrupted");
    expect(JSON.stringify(sink.events)).not.toContain("CANARY");

    const conversationSink = createLifecycleSink();
    const conversation = new RuntimeKernel({
      lifecycleEvents: conversationSink,
      ...ports,
      producerId: "conversation-test",
    });
    await expect(
      conversation.startTurn({
        run: { ...run, executionCapability: "conversation" },
        turn,
        runAttemptId,
      }),
    ).rejects.toMatchObject({ code: "turn_cancelled" });
    expect(terminalEvents(conversationSink)).toHaveLength(1);
    expect(conversationSink.events.at(-1)?.type).toBe("turn.interrupted");
    expect(JSON.stringify(conversationSink.events)).not.toContain("CANARY");
    expect(eventTypes(conversationSink)).not.toContain(
      "workspace.snapshot_captured",
    );
  });

  it("settles a stop queued before kernel execution through the canonical lifecycle", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    const kernel = await createKernel(sink, ports);

    kernel.requestInterruptBeforeStart(
      turn.id,
      "User stopped before execution",
    );
    await kernel.startTurn({ run, turn, runAttemptId });

    expect(ports.provider.generateNext).not.toHaveBeenCalled();
    expect(terminalEvents(sink)).toHaveLength(1);
    expect(sink.events.at(-1)).toMatchObject({
      type: "turn.interrupted",
      payload: {
        outcome: {
          status: "interrupted",
          reason: "The operation was cancelled.",
        },
      },
    });
  });

  it("interrupts active tool work and rejects its later completion write", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    const worker =
      deferred<Awaited<ReturnType<typeof ports.worker.executeTool>>>();
    ports.provider.generateNext = vi.fn(async () => toolStep());
    ports.worker.executeTool = vi.fn(() => worker.promise);
    const artifacts = createArtifactPorts(partialDiff());
    const kernel = await createKernel(sink, ports, artifacts);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await vi.waitFor(() => expect(ports.worker.executeTool).toHaveBeenCalled());

    await kernel.interruptTurn(turn.id, "User cancelled the turn");
    worker.resolve({ kind: "completed", output: { ok: true } });

    await expect(execution).rejects.toBeInstanceOf(LifecycleTransitionError);
    expect(eventTypes(sink).slice(-4)).toEqual([
      "tool_call.interrupted",
      "item.interrupted",
      "run_attempt.interrupted",
      "turn.interrupted",
    ]);
    expect(eventTypes(sink)).toContain("workspace.snapshot_unavailable");
    expect(artifacts.gitSnapshots.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(artifacts.turnArtifacts.putTurnDiff).not.toHaveBeenCalled();
  });

  it("scopes cancellation to the requested turn while another turn continues", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    const secondTurn = TurnSchema.parse({
      ...turn,
      id: "trn_runtime002",
    });
    const secondRunAttemptId = RunAttemptIdSchema.parse("attempt_runtime002");
    const firstWorker =
      deferred<Awaited<ReturnType<typeof ports.worker.executeTool>>>();
    const secondWorker =
      deferred<Awaited<ReturnType<typeof ports.worker.executeTool>>>();
    const providerCalls = new Map<string, number>();

    ports.provider.generateNext = vi.fn(async ({ turn: currentTurn }) => {
      const callCount = (providerCalls.get(currentTurn.id) ?? 0) + 1;
      providerCalls.set(currentTurn.id, callCount);
      if (callCount === 1) return toolStepFor(currentTurn.id);
      return {
        kind: "complete" as const,
        itemId: ItemIdSchema.parse(`itm_${currentTurn.id.slice(4)}_final`),
        output: "Done",
      };
    });
    ports.worker.executeTool = vi.fn(
      async ({ turnId: currentTurnId, signal }) => {
        if (currentTurnId === turn.id) {
          signal?.addEventListener(
            "abort",
            () =>
              firstWorker.resolve({
                kind: "cancelled",
                reason: "User stopped",
              }),
            { once: true },
          );
          return await firstWorker.promise;
        }
        return await secondWorker.promise;
      },
    );

    const kernel = await createKernel(sink, ports);
    const firstExecution = kernel.startTurn({ run, turn, runAttemptId });
    const secondExecution = kernel.startTurn({
      run,
      turn: secondTurn,
      runAttemptId: secondRunAttemptId,
    });
    await vi.waitFor(() =>
      expect(ports.worker.executeTool).toHaveBeenCalledTimes(2),
    );

    await kernel.interruptTurn(turn.id, "User stopped the first turn");

    expect(
      sink.events.filter(
        (event) =>
          event.turnId === secondTurn.id &&
          ["turn.completed", "turn.failed", "turn.interrupted"].includes(
            event.type,
          ),
      ),
    ).toHaveLength(0);
    expect(
      sink.events.filter((event) => event.type === "turn.interrupted"),
    ).toHaveLength(1);

    secondWorker.resolve({ kind: "completed", output: { ok: true } });
    await expect(firstExecution).rejects.toMatchObject({
      code: "turn_cancelled",
    });
    await expect(secondExecution).resolves.toMatchObject({
      status: "completed",
      output: "Done",
    });
    expect(
      sink.events.filter(
        (event) =>
          event.turnId === secondTurn.id &&
          ["turn.completed", "turn.failed", "turn.interrupted"].includes(
            event.type,
          ),
      ),
    ).toHaveLength(1);
  });

  it("persists a multi-file diff before successful terminal settlement", async () => {
    const sink = createLifecycleSink();
    const artifacts = createArtifactPorts(multiFileDiff());
    const kernel = await createKernel(sink, createPorts(), artifacts);

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(artifacts.turnArtifacts.putTurnDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.objectContaining({ files: multiFileDiff().files }),
      }),
    );
    expect(eventTypes(sink).indexOf("artifact.created")).toBeLessThan(
      eventTypes(sink).indexOf("turn.completed"),
    );
  });

  it("persists an explicit empty diff before successful settlement", async () => {
    const artifacts = createArtifactPorts();
    const kernel = await createKernel(
      createLifecycleSink(),
      createPorts(),
      artifacts,
    );

    await kernel.startTurn({ run, turn, runAttemptId });

    expect(artifacts.turnArtifacts.putTurnDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.objectContaining({ files: [], patch: "" }),
      }),
    );
  });

  it("preserves partial changed files when a turn fails", async () => {
    const sink = createLifecycleSink();
    const ports = createPorts();
    ports.provider.generateNext = vi.fn(async () => {
      throw new Error("provider disconnected");
    });
    const artifacts = createArtifactPorts(partialDiff());
    const kernel = await createKernel(sink, ports, artifacts);

    await expect(kernel.startTurn({ run, turn, runAttemptId })).rejects.toThrow(
      "provider disconnected",
    );

    expect(artifacts.turnArtifacts.putTurnDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.objectContaining({ files: partialDiff().files }),
      }),
    );
    expect(eventTypes(sink).indexOf("artifact.created")).toBeLessThan(
      eventTypes(sink).indexOf("turn.failed"),
    );
  });

  it("serializes an interrupt racing tool completion without conflicting settlement", async () => {
    const sink = new BlockingToolCompletionSink();
    const ports = createPorts();
    ports.provider.generateNext = vi
      .fn()
      .mockResolvedValueOnce(toolStep())
      .mockResolvedValueOnce({
        kind: "complete",
        itemId: finalItemId,
        output: "Done",
      });
    const kernel = await createKernel(sink, ports);
    const execution = kernel.startTurn({ run, turn, runAttemptId });
    await sink.waitUntilBlocked();

    const interruption = kernel.interruptTurn(
      turn.id,
      "User cancelled the turn",
    );
    sink.release();
    await interruption;

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(
      eventTypes(sink).filter((type) => type === "tool_call.completed"),
    ).toHaveLength(1);
    expect(eventTypes(sink)).not.toContain("tool_call.interrupted");
    expect(sink.events.map((event) => event.sequence)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(sink.events.at(-1)?.type).toBe("turn.interrupted");

    // Artifact capture is awaited after provider completion. A Stop accepted
    // while that capture is pending must still win canonical terminal outcome.
    {
      const captureSink = createLifecycleSink();
      const capturePorts = createPorts();
      const captureArtifacts = createArtifactPorts();
      const captureGate = deferred<Awaited<ReturnType<typeof captureArtifacts.gitSnapshots.captureSnapshot>>>();
      const originalCapture = captureArtifacts.gitSnapshots.captureSnapshot;
      let terminalCaptureStarted = false;
      let captureCount = 0;
      captureArtifacts.gitSnapshots.captureSnapshot = vi.fn(async (input) => {
        captureCount += 1;
        if (captureCount === 2) {
          terminalCaptureStarted = true;
          return captureGate.promise;
        }
        return originalCapture(input);
      });
      const captureKernel = await createKernel(captureSink, capturePorts, captureArtifacts);
      const capturing = captureKernel.startTurn({ run, turn, runAttemptId });
      const rejectedCapture = expect(capturing).rejects.toMatchObject({ code: "turn_cancelled" });
      await vi.waitFor(() => expect(terminalCaptureStarted).toBe(true));
      const stoppingCapture = captureKernel.interruptTurn(turn.id, "Stop during snapshot capture");
      captureGate.resolve({ runId: run.id, filesystemRoot: manifest.filesystemRoot, headSha: "a".repeat(40), treeId: "b".repeat(40) });
      await stoppingCapture;
      await rejectedCapture;
      expect(captureSink.events.at(-1)?.type).toBe("turn.interrupted");
      expect(captureSink.events.some((event) => event.type === "turn.completed")).toBe(false);
    }

    {
      const captureSink = createLifecycleSink();
      const capturePorts = createPorts();
      const artifacts = createArtifactPorts(partialDiff());
      const gate = deferred<Awaited<ReturnType<typeof artifacts.gitSnapshots.getSnapshotDiff>>>();
      artifacts.gitSnapshots.getSnapshotDiff = vi.fn(() => gate.promise);
      const captureKernel = await createKernel(captureSink, capturePorts, artifacts);
      const captureExecution = captureKernel.startTurn({ run, turn, runAttemptId });
      const rejectedCapture = expect(captureExecution).rejects.toMatchObject({ code: "turn_cancelled" });
      await vi.waitFor(() => expect(artifacts.gitSnapshots.getSnapshotDiff).toHaveBeenCalled());
      const stopCapture = captureKernel.interruptTurn(turn.id, "Stopped during capture");
      gate.resolve(partialDiff());
      await stopCapture;
      await rejectedCapture;
      expect(terminalEvents(captureSink)).toHaveLength(1);
      expect(eventTypes(captureSink)).not.toContain("turn.completed");
      expect(captureSink.events.at(-1)?.type).toBe("turn.interrupted");
    }
  });
});

async function createKernel(
  lifecycleEvents: RuntimeLifecycleEventStore,
  ports = createPorts(),
  artifactPorts = createArtifactPorts(),
  hooks?: RuntimeHookOrchestrationPort,
  contextCompaction?: ContextCompactionPort,
): Promise<RuntimeKernel> {
  return new RuntimeKernel({
    lifecycleEvents,
    ...artifactPorts,
    workspaceManifests: await createManifestRepository(),
    ...ports,
    hooks,
    contextCompaction,
    producerId: "runtime-kernel-test",
    clock: { now: () => timestamp },
  });
}

function partialDiff() {
  return {
    files: [
      {
        path: "src/index.ts",
        previousPath: null,
        status: "modified" as const,
        additions: 2,
        deletions: 1,
      },
    ],
    patch: "diff --git a/src/index.ts b/src/index.ts\n",
  };
}

function multiFileDiff() {
  return {
    files: [
      ...partialDiff().files,
      {
        path: "src/new.ts",
        previousPath: null,
        status: "added" as const,
        additions: 4,
        deletions: 0,
      },
    ],
    patch: `${partialDiff().patch}diff --git a/src/new.ts b/src/new.ts\n`,
  };
}

function toolStep() {
  return toolStepFor("trn_runtime001");
}

function toolStepFor(turnId: string) {
  const suffix = turnId.slice(4);
  return {
    kind: "tool_call" as const,
    itemId: ItemIdSchema.parse(`itm_${suffix}`),
    content: {
      toolCallId: ToolCallIdSchema.parse(`toolcall_${suffix}`),
      toolName: "write_file",
      input: { path: "src/index.ts" },
    },
  };
}

function protocolFailure(message: string) {
  return {
    code: "command_failed" as const,
    message,
    retryable: false,
    correlationId: null,
    details: null,
  };
}

function eventTypes(sink: MemoryLifecycleEventSink): string[] {
  return sink.events.map((event) => event.type);
}

function terminalEvents(sink: MemoryLifecycleEventSink): LifecycleEvent[] {
  return sink.events.filter((event) =>
    ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

class FailingCompletedSettlementSink extends MemoryLifecycleEventSink {
  constructor(private remainingFailures: number) {
    super();
  }

  override async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    if (
      this.remainingFailures > 0 &&
      events.some((event) => event.type === "turn.completed")
    ) {
      this.remainingFailures -= 1;
      throw new Error("simulated atomic append failure");
    }
    return await super.appendBatch(events);
  }
}

class BlockingToolCompletionSink extends MemoryLifecycleEventSink {
  private readonly blocked = deferred<void>();
  private readonly released = deferred<void>();
  private shouldBlock = true;

  async waitUntilBlocked(): Promise<void> {
    await this.blocked.promise;
  }

  release(): void {
    this.released.resolve(undefined);
  }

  override async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    if (
      this.shouldBlock &&
      events.some((event) => event.type === "tool_call.completed")
    ) {
      this.shouldBlock = false;
      this.blocked.resolve(undefined);
      await this.released.promise;
    }
    return await super.appendBatch(events);
  }
}
