import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { CoreMessage, CoreTool } from "ai";
import { z } from "zod";
import {
  ApprovalDecisionKindSchema,
  RUN_EVENT_TYPES,
  RUN_TERMINAL_STATES,
  RUN_WORKFLOW_STEPS,
  type RunEvent,
} from "@repo/shared-types";
import { RunIdSchema } from "@repo/platform-protocol";
import {
  PermissionApprovalStore,
  RunEventRecorder,
  RunEventRepository,
  projectRunActivityFeed,
  projectRunSummaryFromEvents,
  tagRuntimeStateSemantics,
  RunRepository,
  TaskRepository,
  RuntimeKernelNativeRunner,
} from "@shadowbox/execution-engine/runtime";
import type { Env } from "../types/ai";
import { parseExecuteRunRequest } from "./parsing/RunEngineRequestParser";
import {
  SerializableToolDefinitionSchema,
  type ExecuteRunPayload,
} from "./parsing/ExecuteRunPayloadSchema";
import { buildRuntimeDependencies } from "./factories/ExecutionGatewayFactory";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { mapRunExecutionErrorToDomain } from "./RunExecutionErrorMapper";
import { sanitizeUnknownError } from "../core/security/LogSanitizer";
import { buildRunEngineRuntimeDebugPayload } from "../core/observability/runtime";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";
import {
  runEngineErrorResponse,
  runEngineJsonResponse,
  withRunEngineHeaders,
} from "./RunEngineHttpResponse";
import { createEditArtifactCoordinator } from "../services/edit-artifacts/EditArtifactCaptureService";
import type { PersistedAssistantMessageResult } from "./RunEngineResponsePersistence";
import type { RealtimeEventPort } from "./ports";
import { RunEngineCanonicalEventSink } from "./RunEngineCanonicalEventSink";
import { RunEngineKernelLifecycleEventStore } from "./RunEngineKernelLifecycleEventStore";
import {
  getCodingCoreToolRegistry,
  enforceCodingToolFloor,
} from "@shadowbox/execution-engine/runtime";

const CancelRunRequestSchema = z.object({
  runId: RunIdSchema,
});
const ApprovalDecisionRequestSchema = z.object({
  runId: RunIdSchema,
  requestId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
});

export interface RunEngineRequestLock {
  <T>(runId: string, operation: () => Promise<T>): Promise<T>;
}

export interface RunEngineExecuteResult {
  correlationId: string;
  runId: string;
  sessionId: string;
  response: Response;
}

export type RunEnginePostExecutionResult =
  PersistedAssistantMessageResult | null | void;

export interface CanonicalRunEventSink {
  persist(event: RunEvent, correlationId: string): Promise<void>;
}

export interface RunEngineRequestHandlerDependencies {
  canonicalEventSink?: CanonicalRunEventSink;
}

export class RunEngineRequestHandler {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly withExecutionLock: RunEngineRequestLock,
    private readonly eventStream?: RealtimeEventPort,
    private readonly dependencies: RunEngineRequestHandlerDependencies = {},
  ) {}

  async handleSummaryRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runIdRaw = url.searchParams.get("runId");

    if (!runIdRaw) {
      return runEngineErrorResponse(
        request,
        this.env,
        "runId is required",
        400,
      );
    }

    let runId: string;
    try {
      runId = validateWithSchema<string>(
        runIdRaw.trim(),
        RunIdSchema,
        "run-summary",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const eventRepo = new RunEventRepository(runtimeState);
    const approvalStore = new PermissionApprovalStore(runtimeState, runId);

    const run = await runRepo.getById(runId);
    const events = await eventRepo.getByRun(runId);
    const pendingApproval = await approvalStore.getPendingRequest();
    const summary = projectRunSummaryFromEvents(
      runId,
      run?.status ?? null,
      events,
    );

    return runEngineJsonResponse(request, this.env, {
      ...summary,
      terminalState: run?.metadata.terminalState ?? null,
      terminalMessage: run?.metadata.terminalMessage ?? null,
      planArtifact: run?.metadata.planArtifact ?? null,
      permissionContext: run?.metadata.permissionContext ?? null,
      pendingApproval,
    });
  }

  async handleEventsRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runIdRaw = url.searchParams.get("runId");

    if (!runIdRaw) {
      return runEngineErrorResponse(
        request,
        this.env,
        "runId is required",
        400,
      );
    }

    let runId: string;
    try {
      runId = validateWithSchema<string>(
        runIdRaw.trim(),
        RunIdSchema,
        "run-events",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    const runtimeState = this.createRuntimeState();
    const eventRepo = new RunEventRepository(runtimeState);
    const events = await eventRepo.getByRun(runId);
    return withRunEngineHeaders(
      request,
      this.env,
      this.buildEventsResponse(events, runId),
    );
  }

  async handleEventsStreamRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runIdRaw = url.searchParams.get("runId");

    if (!runIdRaw) {
      return runEngineErrorResponse(
        request,
        this.env,
        "runId is required",
        400,
      );
    }

    let runId: string;
    try {
      runId = validateWithSchema<string>(
        runIdRaw.trim(),
        RunIdSchema,
        "run-events-stream",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    if (!this.eventStream) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Realtime event stream is unavailable",
        503,
      );
    }
    console.log(
      formatDiagnosticLogLine("run/events", "stream-opened", {
        runId,
      }),
    );
    return withRunEngineHeaders(
      request,
      this.env,
      new Response(this.eventStream.getStream(runId), {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Run-Id": runId,
        },
      }),
    );
  }

  async handleActivityRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runIdRaw = url.searchParams.get("runId");

    if (!runIdRaw) {
      return runEngineErrorResponse(
        request,
        this.env,
        "runId is required",
        400,
      );
    }

    let runId: string;
    try {
      runId = validateWithSchema<string>(
        runIdRaw.trim(),
        RunIdSchema,
        "run-activity",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const eventRepo = new RunEventRepository(runtimeState);
    const run = await runRepo.getById(runId);
    const events = await eventRepo.getByRun(runId);
    const activity = projectRunActivityFeed({ runId, run, events });

    return runEngineJsonResponse(request, this.env, activity);
  }

  async handleCancelRequest(request: Request): Promise<Response> {
    let runId: string;
    try {
      const payload = await parseRequestBody(request, "run-cancel");
      const validated = validateWithSchema<{ runId: string }>(
        payload,
        CancelRunRequestSchema,
        "run-cancel",
      );
      runId = validated.runId;
    } catch {
      return runEngineErrorResponse(
        request,
        this.env,
        "Invalid cancel payload",
        400,
      );
    }

    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const taskRepo = new TaskRepository(runtimeState);

    const run = await runRepo.getById(runId);
    if (!run) {
      return runEngineJsonResponse(request, this.env, {
        runId,
        cancelled: false,
        status: null,
      });
    }
    const runEventRecorder = new RunEventRecorder(
      new RunEventRepository(runtimeState),
      runId,
      run.sessionId,
      async (event) => {
        await this.persistCanonicalRunEvent(event, "run-cancel");
        this.emitLiveEvent(event);
      },
    );

    const isTerminal =
      run.status === "COMPLETED" ||
      run.status === "FAILED" ||
      run.status === "CANCELLED";
    if (isTerminal) {
      return runEngineJsonResponse(request, this.env, {
        runId,
        cancelled: false,
        status: run.status,
      });
    }

    const previousStatus = run.status;
    run.transition("CANCELLED");
    await runRepo.update(run);
    await runEventRecorder.recordRunStatusChanged(
      previousStatus,
      run.status,
      RUN_WORKFLOW_STEPS.EXECUTION,
      "user_cancelled",
    );
    await runEventRecorder.recordMessageEmitted(
      "assistant",
      "The run was cancelled before execution could finish.",
      { terminalState: RUN_TERMINAL_STATES.INTERRUPTED },
      { phase: "final_answer", status: "completed" },
    );

    let cancelledTasks = 0;
    const tasks = await taskRepo.getByRun(runId);
    for (const task of tasks) {
      if (["PENDING", "READY", "RUNNING"].includes(task.status)) {
        task.transition("CANCELLED");
        await taskRepo.update(task);
        cancelledTasks += 1;
      }
    }

    this.eventStream?.complete(runId);

    return runEngineJsonResponse(request, this.env, {
      runId,
      cancelled: true,
      status: "CANCELLED",
      cancelledTasks,
    });
  }

  async handleApprovalRequest(request: Request): Promise<Response> {
    let payload: z.infer<typeof ApprovalDecisionRequestSchema>;
    try {
      const body = await parseRequestBody(request, "run-approval");
      payload = validateWithSchema(
        body,
        ApprovalDecisionRequestSchema,
        "run-approval",
      );
    } catch {
      return runEngineErrorResponse(
        request,
        this.env,
        "Invalid approval payload",
        400,
      );
    }

    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const run = await runRepo.getById(payload.runId);
    if (!run) {
      return runEngineErrorResponse(request, this.env, "Run not found", 404);
    }

    const approvalStore = new PermissionApprovalStore(
      runtimeState,
      payload.runId,
    );
    const runEventRecorder = new RunEventRecorder(
      new RunEventRepository(runtimeState),
      payload.runId,
      run.sessionId,
      async (event) => {
        await this.persistCanonicalRunEvent(event, "run-approval");
        this.emitLiveEvent(event);
      },
    );

    let decisionResult: Awaited<
      ReturnType<typeof approvalStore.resolveDecision>
    >;
    try {
      decisionResult = await approvalStore.resolveDecision(
        {
          kind: payload.decision,
          requestId: payload.requestId,
        },
        run.metadata.actorUserId,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to resolve approval decision";
      try {
        await runEventRecorder.recordRunProgress(
          RUN_WORKFLOW_STEPS.EXECUTION,
          "Approval decision ignored",
          message,
          "completed",
        );
      } catch (recordError) {
        console.warn(
          `[run/approval] failed to record ignored approval decision: ${sanitizeUnknownError(recordError)}`,
        );
      }
      const status = message.includes("No pending approval request")
        ? 409
        : message.includes("does not match pending request")
          ? 409
          : message.includes("not allowed for this request")
            ? 400
            : message.includes("rejected because it is too broad")
              ? 400
              : message.includes("authenticated user id")
                ? 400
                : 500;
      return runEngineErrorResponse(request, this.env, message, status);
    }

    await runEventRecorder.recordApprovalResolved({
      requestId: decisionResult.request.requestId,
      decision: decisionResult.decision,
      status:
        decisionResult.status === "approved"
          ? "approved"
          : decisionResult.status === "aborted"
            ? "aborted"
            : "denied",
    });

    return runEngineJsonResponse(request, this.env, {
      runId: payload.runId,
      requestId: decisionResult.request.requestId,
      decision: decisionResult.decision,
      status: decisionResult.status,
      persistentRuleId: decisionResult.persistentRuleId ?? null,
      pendingApproval: await approvalStore.getPendingRequest(),
    });
  }

  async handleRuntimeDebugRequest(request: Request): Promise<Response> {
    return runEngineJsonResponse(
      request,
      this.env,
      buildRunEngineRuntimeDebugPayload(this.env),
    );
  }

  async handleExecuteRequest(
    request: Request,
    onExecuteResult?: (
      result: RunEngineExecuteResult,
    ) => Promise<RunEnginePostExecutionResult> | RunEnginePostExecutionResult,
  ): Promise<Response> {
    let payload: ExecuteRunPayload;
    try {
      payload = await parseExecuteRunRequest(request);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        return runEngineErrorResponse(
          request,
          this.env,
          message,
          status,
          code,
          metadata,
        );
      }
      const message =
        error instanceof Error ? error.message : "Invalid payload";
      return runEngineErrorResponse(request, this.env, message, 400);
    }

    try {
      console.log(
        formatDiagnosticLogLine("run/runtime", "execute-request-accepted", {
          correlationId: payload.correlationId,
          runId: payload.runId,
          sessionId: payload.sessionId,
          providerId: payload.input.providerId ?? null,
          modelId: payload.input.modelId ?? null,
          mode: payload.input.mode,
          messageCount: payload.messages.length,
          toolCount: payload.tools?.length ?? 0,
        }),
      );
      return await this.withExecutionLock(payload.runId, async () => {
        this.eventStream?.start(payload.runId);
        const runtimeState = this.createRuntimeState();
        const { agent, runEngineDeps } = buildRuntimeDependencies(
          this.ctx,
          this.env,
          payload,
          { strict: true },
        );
        console.log(
          formatDiagnosticLogLine("run/runtime", "dependencies-ready", {
            correlationId: payload.correlationId,
            runId: payload.runId,
            sessionId: payload.sessionId,
            hasEventStream: Boolean(this.eventStream),
            toolCount: payload.tools?.length ?? 0,
          }),
        );
        const editArtifactCoordinator = createEditArtifactCoordinator({
          env: this.env,
          userId: payload.userId,
          workspaceId: payload.workspaceId,
          runId: payload.runId,
          sessionId: payload.sessionId,
          repositoryContext: payload.input.repositoryContext,
        });
        const userMessageId = readLatestUserMessageId(payload.messages);
        editArtifactCoordinator.setMessageContext({
          userMessageId: userMessageId ?? undefined,
          sourceTurnId: userMessageId ?? undefined,
        });
        const canonicalEventSink = this.createCanonicalEventSink();

        const runtimeRunner = new RuntimeKernelNativeRunner(
          runtimeState,
          {
            env: this.env,
            sessionId: payload.sessionId,
            runId: payload.runId,
            userId: payload.userId,
            correlationId: payload.correlationId,
            requestOrigin: payload.requestOrigin,
          },
          agent,
          {
            ...runEngineDeps,
            runEventListener: async (event) => {
              await canonicalEventSink.persist(event, payload.correlationId);
              this.emitLiveEvent(event);
              editArtifactCoordinator.handleEvent(event);
            },
          },
        );

        const runtimeTools = toRuntimeCoreTools(payload.tools);
        const kernelLifecycleEvents = new RunEngineKernelLifecycleEventStore({
          runId: payload.runId,
          sessionId: payload.sessionId,
          correlationId: payload.correlationId,
          sink: canonicalEventSink,
          onRunEvent: (event) => this.emitLiveEvent(event),
        });
        await editArtifactCoordinator.prepare();
        const executionResponse = await runtimeRunner.execute({
          input: payload.input,
          messages: payload.messages as CoreMessage[],
          tools: runtimeTools,
          lifecycleEvents: kernelLifecycleEvents,
        });
        console.log(
          formatDiagnosticLogLine("run/runtime", "engine-executed", {
            correlationId: payload.correlationId,
            runId: payload.runId,
            sessionId: payload.sessionId,
            responseStatus: executionResponse.status,
          }),
        );

        const postExecutionResult = onExecuteResult
          ? await onExecuteResult({
              correlationId: payload.correlationId,
              runId: payload.runId,
              sessionId: payload.sessionId,
              response: executionResponse,
            })
          : null;
        console.log(
          formatDiagnosticLogLine("run/runtime", "post-execution-handled", {
            correlationId: payload.correlationId,
            runId: payload.runId,
            sessionId: payload.sessionId,
            assistantMessageId: postExecutionResult?.assistantMessageId ?? null,
          }),
        );
        if (postExecutionResult?.assistantMessageId) {
          editArtifactCoordinator.setMessageContext({
            assistantMessageId: postExecutionResult.assistantMessageId,
          });
        }
        await editArtifactCoordinator.waitForPendingCapture();
        console.log(
          formatDiagnosticLogLine("run/runtime", "artifacts-settled", {
            correlationId: payload.correlationId,
            runId: payload.runId,
            sessionId: payload.sessionId,
          }),
        );

        return withRunEngineHeaders(request, this.env, executionResponse);
      });
    } catch (error: unknown) {
      const domainError = mapRunExecutionErrorToDomain(
        error,
        payload.correlationId,
      );
      if (domainError) {
        const { status, code, message, metadata } =
          mapDomainErrorToHttp(domainError);
        return runEngineErrorResponse(
          request,
          this.env,
          message,
          status,
          code,
          metadata,
        );
      }
      console.error(
        `[run/engine-runtime] ${payload.correlationId}: untyped runtime failure: ${sanitizeUnknownError(error)}`,
      );
      const message =
        error instanceof Error
          ? error.message
          : "RunEngine DO execution failed";
      return runEngineErrorResponse(request, this.env, message, 500);
    }
  }

  private createRuntimeState() {
    return tagRuntimeStateSemantics(
      this.ctx as unknown as LegacyDurableObjectState,
      "do",
    );
  }

  private emitLiveEvent(event: RunEvent): void {
    if (!this.eventStream) {
      console.log(
        `[run/events-live] runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=skipped reason=stream-unavailable`,
      );
      return;
    }

    this.eventStream.emit(event);
    console.log(
      `[run/events-live] runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=emitted`,
    );
    if (
      event.type === RUN_EVENT_TYPES.RUN_COMPLETED ||
      event.type === RUN_EVENT_TYPES.RUN_FAILED
    ) {
      this.eventStream.complete(event.runId);
      console.log(
        `[run/events-live] runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=completed-stream`,
      );
    }
  }

  private async persistCanonicalRunEvent(
    event: RunEvent,
    correlationId: string,
  ): Promise<void> {
    await this.createCanonicalEventSink().persist(event, correlationId);
  }

  private createCanonicalEventSink(): CanonicalRunEventSink {
    return (
      this.dependencies.canonicalEventSink ??
      new RunEngineCanonicalEventSink(this.env)
    );
  }

  private buildEventsResponse(events: unknown[], runId: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "X-Run-Id": runId,
      },
    });
  }
}

function readLatestUserMessageId(
  messages: ExecuteRunPayload["messages"],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    return message.id?.trim() || null;
  }
  return null;
}

function toRuntimeCoreTools(
  tools: ExecuteRunPayload["tools"],
): Record<string, CoreTool> {
  const parsedTools: Record<string, CoreTool> = {};
  if (tools) {
    for (const [toolName, definition] of Object.entries(tools)) {
      const validatedDefinition =
        SerializableToolDefinitionSchema.parse(definition);
      parsedTools[toolName] = {
        ...validatedDefinition,
        parameters: validatedDefinition.parameters ?? {},
      } as CoreTool;
    }
  }

  if (Object.keys(parsedTools).length === 0) {
    return getCodingCoreToolRegistry();
  }

  return enforceCodingToolFloor(parsedTools);
}
