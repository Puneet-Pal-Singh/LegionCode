import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { CoreMessage, CoreTool } from "ai";
import { z } from "zod";
import {
  ApprovalDecisionKindSchema,
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  type RunEvent,
} from "@repo/shared-types";
import {
  PermissionApprovalStore,
  RunEngine,
  RunEventRecorder,
  RunEventRepository,
  projectRunActivityFeed,
  projectRunSummaryFromEvents,
  tagRuntimeStateSemantics,
  RunRepository,
  TaskRepository,
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
import {
  runEngineErrorResponse,
  runEngineJsonResponse,
  withRunEngineHeaders,
} from "./RunEngineHttpResponse";
import { createEditArtifactCoordinator } from "../services/edit-artifacts/EditArtifactCaptureService";
import type { RealtimeEventPort } from "./ports";
import {
  enforceGoldenFlowToolFloor,
  getGoldenFlowToolRegistry,
} from "@shadowbox/execution-engine/runtime";

const RunIdSchema = z.string().uuid();
const CancelRunRequestSchema = z.object({
  runId: RunIdSchema,
});
const ApprovalDecisionRequestSchema = z.object({
  runId: RunIdSchema,
  requestId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
});

export interface RunEngineRequestLock {
  <T>(operation: () => Promise<T>): Promise<T>;
}

export interface RunEngineExecuteResult {
  correlationId: string;
  runId: string;
  sessionId: string;
  response: Response;
}

export class RunEngineRequestHandler {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly withExecutionLock: RunEngineRequestLock,
    private readonly eventStream?: RealtimeEventPort,
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
        "Live event stream is unavailable",
        501,
      );
    }

    return withRunEngineHeaders(
      request,
      this.env,
      new Response(this.eventStream.getStream(runId) as ReadableStream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
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

    return runEngineJsonResponse(
      request,
      this.env,
      projectRunActivityFeed({ runId, run, events }),
    );
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
      (event) => {
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
      (event) => {
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
    onExecuteResult?: (result: RunEngineExecuteResult) => Promise<void> | void,
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
      return await this.withExecutionLock(async () => {
        const runtimeState = this.createRuntimeState();
        const { agent, runEngineDeps } = buildRuntimeDependencies(
          this.ctx,
          this.env,
          payload,
          { strict: true },
        );
        const editArtifactCoordinator = createEditArtifactCoordinator({
          env: this.env,
          userId: payload.userId,
          workspaceId: payload.workspaceId,
          runId: payload.runId,
          sessionId: payload.sessionId,
          repositoryContext: payload.input.repositoryContext,
        });

        const runEngine = new RunEngine(
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
          undefined,
          {
            ...runEngineDeps,
            runEventListener: (event) => {
              this.emitLiveEvent(event);
              editArtifactCoordinator.handleEvent(event);
            },
          },
        );

        const executionResponse = await runEngine.execute(
          payload.input,
          payload.messages as CoreMessage[],
          toRuntimeCoreTools(payload.tools),
        );

        if (onExecuteResult) {
          await onExecuteResult({
            correlationId: payload.correlationId,
            runId: payload.runId,
            sessionId: payload.sessionId,
            response: executionResponse,
          });
        }
        await editArtifactCoordinator.waitForPendingCapture();

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
      return;
    }

    this.eventStream.emit(event);
    if (
      event.type === RUN_EVENT_TYPES.RUN_COMPLETED ||
      event.type === RUN_EVENT_TYPES.RUN_FAILED
    ) {
      this.eventStream.complete(event.runId);
    }
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
    return getGoldenFlowToolRegistry();
  }

  return enforceGoldenFlowToolFloor(parsedTools);
}
