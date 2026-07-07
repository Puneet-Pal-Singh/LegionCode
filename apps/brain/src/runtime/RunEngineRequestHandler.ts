import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { CoreMessage, CoreTool } from "ai";
import { z } from "zod";
import type { LifecycleEventStore } from "@repo/persistence";
import {
  ApprovalDecisionKindSchema,
  RUN_EVENT_TYPES,
  RUN_TERMINAL_STATES,
  RUN_WORKFLOW_STEPS,
  type RunEvent,
} from "@repo/shared-types";
import {
  ApprovalDecisionSchema,
  ApprovalIdSchema,
  createTurnId,
  EventSequenceSchema,
  type LifecycleEvent,
  RunIdSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
} from "@repo/platform-protocol";
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
import { CloudflareLifecycleEventStreamAdapter } from "./adapters/CloudflareLifecycleEventStreamAdapter";
import { BrainLifecycleEventStore } from "../services/lifecycle/BrainLifecycleEventStore";
import type { LifecycleEventStreamPort } from "./ports";
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
const LifecycleApprovalDecisionRequestSchema = z.object({
  turnId: TurnIdSchema,
  approvalId: ApprovalIdSchema,
  decision: ApprovalDecisionSchema,
  decidedBy: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});
const LifecycleEventsQuerySchema = z.object({
  turnId: TurnIdSchema,
  afterSequence: EventSequenceSchema.nullable(),
  limit: z.number().int().min(1).max(1_000),
});
const LifecycleEventsStreamQuerySchema = z.object({
  turnId: TurnIdSchema,
  afterSequence: EventSequenceSchema.nullable(),
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
  lifecycleEventStore?: LifecycleEventStore;
  lifecycleEventStream?: LifecycleEventStreamPort;
}

export class RunEngineRequestHandler {
  private readonly fallbackLifecycleEventStream =
    new CloudflareLifecycleEventStreamAdapter();

  private readonly turnToRunMap = new Map<string, string>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly withExecutionLock: RunEngineRequestLock,
    private readonly eventStream?: RealtimeEventPort,
    private readonly dependencies: RunEngineRequestHandlerDependencies = {},
  ) {}

  async handleLifecycleEventsRequest(request: Request): Promise<Response> {
    const input = parseLifecycleEventsQuery(request);
    if (!input.ok) {
      return runEngineErrorResponse(request, this.env, input.message, 400);
    }

    const replay = await this.createLifecycleEventStore().replay(input.value);
    return runEngineJsonResponse(request, this.env, replay);
  }

  async handleLifecycleEventsStreamRequest(
    request: Request,
  ): Promise<Response> {
    const input = parseLifecycleEventsStreamQuery(request);
    if (!input.ok) {
      return runEngineErrorResponse(request, this.env, input.message, 400);
    }

    return withRunEngineHeaders(
      request,
      this.env,
      new Response(
        this.createLifecycleEventStream().getStream(
          input.value.turnId,
          input.value.afterSequence,
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Turn-Id": input.value.turnId,
          },
        },
      ),
    );
  }

  async handleTurnDiffRequest(request: Request): Promise<Response> {
    const input = parseLifecycleEventsStreamQuery(request);
    if (!input.ok) {
      return runEngineErrorResponse(request, this.env, input.message, 400);
    }

    return runEngineJsonResponse(request, this.env, {
      diff: await readLatestTurnDiff(
        this.createLifecycleEventStore(),
        input.value.turnId,
      ),
    });
  }

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

    this.completeRunStreamAfterCancel(run);

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

  async handleLifecycleApprovalRequest(request: Request): Promise<Response> {
    let payload: z.infer<typeof LifecycleApprovalDecisionRequestSchema>;
    try {
      const body = await parseRequestBody(request, "lifecycle-approval");
      payload = validateWithSchema(
        body,
        LifecycleApprovalDecisionRequestSchema,
        "lifecycle-approval",
      );
    } catch {
      return runEngineErrorResponse(
        request,
        this.env,
        "Invalid lifecycle approval payload",
        400,
      );
    }

    const runId = this.turnToRunMap.get(payload.turnId);
    if (!runId) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Run not found for turnId",
        404,
      );
    }
    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const run = await runRepo.getById(runId);
    if (!run) {
      return runEngineErrorResponse(request, this.env, "Run not found", 404);
    }

    const approvalStore = new PermissionApprovalStore(runtimeState, runId);
    try {
      await approvalStore.resolveDecision(
        {
          kind: mapLifecycleApprovalDecision(payload.decision),
          requestId: payload.approvalId,
        },
        run.metadata.actorUserId,
      );
    } catch (error) {
      return runEngineErrorResponse(
        request,
        this.env,
        error instanceof Error
          ? error.message
          : "Unable to resolve lifecycle approval decision",
        mapApprovalResolutionErrorStatus(error),
      );
    }

    const decidedEvent = await waitForLifecycleApprovalDecisionEvent({
      store: this.createLifecycleEventStore(),
      turnId: payload.turnId,
      approvalId: payload.approvalId,
    });
    if (!decidedEvent) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Approval decision was recorded but the lifecycle decision event was not observed.",
        504,
      );
    }
    return runEngineJsonResponse(request, this.env, decidedEvent);
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
        const turnId = createTurnId();
        this.turnToRunMap.set(turnId, payload.runId);
        this.createLifecycleEventStream().start(turnId);
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
          store: this.createLifecycleEventStore(),
          stream: this.createLifecycleEventStream(),
        });
        await editArtifactCoordinator.prepare();
        const executionResponse = await runtimeRunner.execute({
          input: payload.input,
          messages: payload.messages as CoreMessage[],
          tools: runtimeTools,
          lifecycleEvents: kernelLifecycleEvents,
          turnId,
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

        return withRunEngineHeaders(request, this.env, executionResponse, {
          "X-Turn-Id": turnId,
        });
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

    this.emitLiveEventSafely(event);
    if (
      event.type === RUN_EVENT_TYPES.RUN_COMPLETED ||
      event.type === RUN_EVENT_TYPES.RUN_FAILED
    ) {
      this.completeLiveEventStreamSafely(event);
    }
  }

  private emitLiveEventSafely(event: RunEvent): boolean {
    try {
      this.eventStream?.emit(event);
      console.log(
        `[run/events-live] runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=emitted`,
      );
      return true;
    } catch (error) {
      console.warn(
        formatDiagnosticLogLine("run/events-live", "emit-failed", {
          runId: event.runId,
          sessionId: event.sessionId ?? null,
          eventId: event.eventId,
          type: event.type,
          error: sanitizeUnknownError(error),
        }),
      );
      return false;
    }
  }

  private completeLiveEventStreamSafely(event: RunEvent): void {
    try {
      this.eventStream?.complete(event.runId);
      console.log(
        `[run/events-live] runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=completed-stream`,
      );
    } catch (error) {
      console.warn(
        formatDiagnosticLogLine("run/events-live", "complete-failed", {
          runId: event.runId,
          sessionId: event.sessionId ?? null,
          eventId: event.eventId,
          type: event.type,
          error: sanitizeUnknownError(error),
        }),
      );
    }
  }

  private completeRunStreamAfterCancel(run: {
    id: string;
    sessionId: string;
  }): void {
    try {
      this.eventStream?.complete(run.id);
    } catch (error) {
      console.warn(
        formatDiagnosticLogLine("run/events-live", "cancel-complete-failed", {
          runId: run.id,
          sessionId: run.sessionId,
          error: sanitizeUnknownError(error),
        }),
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

  private createLifecycleEventStore(): LifecycleEventStore {
    return (
      this.dependencies.lifecycleEventStore ??
      new BrainLifecycleEventStore(this.env)
    );
  }

  private createLifecycleEventStream(): LifecycleEventStreamPort {
    return (
      this.dependencies.lifecycleEventStream ??
      this.fallbackLifecycleEventStream
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

type ParsedLifecycleQuery<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function parseLifecycleEventsQuery(
  request: Request,
): ParsedLifecycleQuery<z.infer<typeof LifecycleEventsQuerySchema>> {
  const url = new URL(request.url);
  return parseLifecycleQuery(
    {
      turnId: readTurnId(url),
      afterSequence: readOptionalSequence(url.searchParams),
      limit: readOptionalLimit(url.searchParams),
    },
    LifecycleEventsQuerySchema,
  );
}

function parseLifecycleEventsStreamQuery(
  request: Request,
): ParsedLifecycleQuery<z.infer<typeof LifecycleEventsStreamQuerySchema>> {
  const url = new URL(request.url);
  return parseLifecycleQuery(
    {
      turnId: readTurnId(url),
      afterSequence: readOptionalSequence(url.searchParams),
    },
    LifecycleEventsStreamQuerySchema,
  );
}

function parseLifecycleQuery<TSchema extends z.ZodTypeAny>(
  input: unknown,
  schema: TSchema,
): ParsedLifecycleQuery<z.infer<TSchema>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    message: parsed.error.issues[0]?.message ?? "Invalid lifecycle query",
  };
}

function readTurnId(url: URL): string | null {
  return readTurnIdFromPath(url.pathname) ?? url.searchParams.get("turnId");
}

function readTurnIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/turns\/([^/]+)\/lifecycle-events(?:\/stream)?$/,
  );
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readOptionalSequence(params: URLSearchParams): number | null {
  const value = params.get("afterSequence");
  return value === null || value.trim() === "" ? null : Number(value);
}

function readOptionalLimit(params: URLSearchParams): number {
  const value = params.get("limit");
  return value === null || value.trim() === "" ? 100 : Number(value);
}

async function readLatestTurnDiff(store: LifecycleEventStore, turnId: string) {
  let afterSequence: number | null = null;
  let latestDiff: unknown = null;

  while (true) {
    const replay = await store.replay({
      turnId: TurnIdSchema.parse(turnId),
      afterSequence,
      limit: 1_000,
    });
    for (const event of replay.events) {
      if (event.type === "turn.diff_updated") {
        latestDiff = event.payload.diff;
      }
    }
    if (replay.events.length < 1_000 || replay.nextSequence === null) {
      break;
    }
    afterSequence = replay.nextSequence;
  }

  return latestDiff === null ? null : TurnDiffPayloadSchema.parse(latestDiff);
}

function mapLifecycleApprovalDecision(
  decision: "approved" | "denied" | "cancelled",
): z.infer<typeof ApprovalDecisionKindSchema> {
  switch (decision) {
    case "approved":
      return "allow_once";
    case "cancelled":
      return "abort";
    case "denied":
      return "deny";
  }
}

function mapApprovalResolutionErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("No pending approval request") ||
    message.includes("does not match pending request")
  ) {
    return 409;
  }
  if (
    message.includes("not allowed for this request") ||
    message.includes("rejected because it is too broad") ||
    message.includes("authenticated user id")
  ) {
    return 400;
  }
  return 500;
}

async function waitForLifecycleApprovalDecisionEvent(input: {
  store: LifecycleEventStore;
  turnId: string;
  approvalId: string;
}): Promise<LifecycleEvent | null> {
  const deadline = Date.now() + 2_000;
  let afterSequence: number | null = null;
  while (Date.now() <= deadline) {
    const found = await findLifecycleApprovalDecisionEvent(
      input,
      afterSequence,
    );
    if (found.event) {
      return found.event;
    }
    afterSequence = found.nextSequence;
    await waitForLifecycleApprovalReplayCycle();
  }
  return null;
}

async function findLifecycleApprovalDecisionEvent(
  input: {
    store: LifecycleEventStore;
    turnId: string;
    approvalId: string;
  },
  afterSequence: number | null,
): Promise<{ event: LifecycleEvent | null; nextSequence: number | null }> {
  const replay = await input.store.replay({
    turnId: TurnIdSchema.parse(input.turnId),
    afterSequence,
    limit: 1_000,
  });
  const event =
    replay.events.find(
      (candidate) =>
        candidate.type === "approval.decided" &&
        candidate.approvalId === input.approvalId,
    ) ?? null;
  return {
    event,
    nextSequence: replay.nextSequence,
  };
}

function waitForLifecycleApprovalReplayCycle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}
