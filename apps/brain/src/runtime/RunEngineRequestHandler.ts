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
  createRunAttemptId,
  createThreadId,
  EventSequenceSchema,
  type LifecycleEvent,
  RunIdSchema,
  turnIdFromRunId,
  TurnScopeBootstrapRequestSchema,
  TurnScopeBootstrapSchema,
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
import { parseTraceparent } from "@repo/observability";
import { reportBrainError } from "../core/observability/BrainErrorReporter";
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
import {
  InMemoryRunInterruptRegistry,
  type RunInterruptRegistry,
} from "./RunInterruptRegistry";
import {
  BrainWorkspaceIdSchema,
  RunInterruptIdentitySchema,
  type RunInterruptIdentity,
} from "./RunInterruptContract";
import { BrainLifecycleEventStore } from "../services/lifecycle/BrainLifecycleEventStore";
import type { LifecycleEventStreamPort } from "./ports";
import {
  getCodingCoreToolRegistry,
  enforceCodingToolFloor,
} from "@shadowbox/execution-engine/runtime";
import { toRuntimeWorkspaceScope } from "./RuntimeWorkspaceScope";

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
  interruptRegistry?: RunInterruptRegistry;
}

type TurnRuntimeIdentity = RunInterruptIdentity;

export class RunEngineRequestHandler {
  private readonly fallbackLifecycleEventStream =
    new CloudflareLifecycleEventStreamAdapter();

  private readonly turnToRunMap = new Map<string, string>();
  private readonly turnRuntimeIdentities = new Map<
    string,
    TurnRuntimeIdentity
  >();
  private readonly interruptRegistry: RunInterruptRegistry;
  private turnToRunMapLoaded = false;

  private static readonly TURN_MAP_STORAGE_KEY = "turnToRunMap";
  private static readonly TURN_IDENTITY_STORAGE_KEY = "turnRuntimeIdentities";

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly withExecutionLock: RunEngineRequestLock,
    private readonly eventStream?: RealtimeEventPort,
    private readonly dependencies: RunEngineRequestHandlerDependencies = {},
  ) {
    this.interruptRegistry =
      dependencies.interruptRegistry ?? new InMemoryRunInterruptRegistry();
  }

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

  async handleInterruptRequest(request: Request): Promise<Response> {
    let payload: TurnRuntimeIdentity;
    try {
      const body = await parseRequestBody(request, "run-interrupt");
      const validated = validateWithSchema<RunInterruptIdentity>(
        body,
        RunInterruptIdentitySchema,
        "run-interrupt",
      );
      payload = validated;
    } catch {
      return runEngineErrorResponse(
        request,
        this.env,
        "Invalid interrupt payload",
        400,
      );
    }

    await this.ensureTurnToRunMapLoaded();

    const runtimeState = this.createRuntimeState();
    const runRepo = new RunRepository(runtimeState);
    const run = await runRepo.getById(payload.runId);
    if (!run) {
      return runEngineJsonResponse(request, this.env, {
        runId: payload.runId,
        accepted: false,
        status: null,
      });
    }

    const identity = this.turnRuntimeIdentities.get(payload.turnId);
    if (
      !identity ||
      run.sessionId !== payload.sessionId ||
      !sameTurnRuntimeIdentity(identity, payload)
    ) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Interrupt identity does not match the active run",
        409,
      );
    }

    const replay = await this.createLifecycleEventStore().replay({
      turnId: payload.turnId,
      afterSequence: null,
      limit: 1_000,
    });
    const terminalEvent = replay.events.find(isTerminalLifecycleEvent);
    if (terminalEvent) {
      return runEngineJsonResponse(request, this.env, {
        runId: payload.runId,
        accepted: false,
        status: "settled",
        terminalEvent,
      });
    }

    const accepted = await this.interruptRegistry.request(
      payload.turnId,
      "User interrupted the turn.",
    );
    if (!accepted) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Turn is no longer interruptible",
        409,
      );
    }

    return runEngineJsonResponse(request, this.env, {
      runId: payload.runId,
      accepted: true,
      status: "interrupt_requested",
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

    await this.ensureTurnToRunMapLoaded();

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

  async handleTurnStartRequest(request: Request): Promise<Response> {
    try {
      const body = await parseRequestBody(request);
      const input = validateWithSchema<
        z.infer<typeof TurnScopeBootstrapRequestSchema>
      >(body, TurnScopeBootstrapRequestSchema);
      const workspaceId = BrainWorkspaceIdSchema.parse(input.workspaceId);

      return await this.withExecutionLock(input.runId, async () => {
        await this.ensureTurnToRunMapLoaded();

        // Bootstrap is idempotent for the server-owned run. A reload or a
        // second client must receive the exact tuple that execution already
        // owns; generating another turn here makes lifecycle routing diverge.
        const existing = [...this.turnRuntimeIdentities.values()].find(
          (candidate) =>
            candidate.runId === input.runId &&
            candidate.sessionId === input.sessionId &&
            candidate.workspaceId === workspaceId,
        );
        if (existing) {
          this.createLifecycleEventStream().start(existing.turnId);
          return runEngineJsonResponse(
            request,
            this.env,
            TurnScopeBootstrapSchema.parse({
              workspaceId: existing.workspaceId,
              threadId: existing.threadId,
              turnId: existing.turnId,
              runAttemptId: existing.runAttemptId,
            }),
            200,
          );
        }

        const identity = TurnScopeBootstrapSchema.parse({
          workspaceId,
          threadId: createThreadId(),
          // Public lifecycle routes can recover the owning run only when the
          // server-issued turn carries the canonical run routing segment.
          turnId: turnIdFromRunId(input.runId, input.sessionId),
          runAttemptId: createRunAttemptId(),
        });
        await this.mapTurnToRun(identity.turnId, input.runId, {
          ...identity,
          runId: input.runId,
          sessionId: input.sessionId,
        });
        this.createLifecycleEventStream().start(identity.turnId);
        return runEngineJsonResponse(request, this.env, identity, 201);
      });
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
      return runEngineErrorResponse(
        request,
        this.env,
        "Failed to persist the server-owned turn bootstrap",
        500,
        "TURN_BOOTSTRAP_FAILED",
      );
    }
  }

  async handleWorkspaceScopeRequest(request: Request): Promise<Response> {
    const runIdRaw = new URL(request.url).searchParams.get("runId");
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
        "workspace-scope",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    await this.ensureTurnToRunMapLoaded();
    const identity = [...this.turnRuntimeIdentities.values()]
      .reverse()
      .find((candidate) => candidate.runId === runId);
    if (!identity) {
      return runEngineErrorResponse(
        request,
        this.env,
        "A server-issued turn scope is required before Git execution",
        428,
        "TURN_SCOPE_REQUIRED",
      );
    }

    return runEngineJsonResponse(
      request,
      this.env,
      toRuntimeWorkspaceScope(identity),
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

    const workspaceId = BrainWorkspaceIdSchema.safeParse(payload.workspaceId);
    if (!workspaceId.success) {
      return runEngineErrorResponse(
        request,
        this.env,
        "workspaceId is required",
        400,
      );
    }

    try {
      const trace = parseTraceparent(request.headers.get("traceparent"));
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
          traceId: trace?.traceId,
          spanId: trace?.spanId,
        }),
      );
      return await this.withExecutionLock(payload.runId, async () => {
        if (!payload.identity) {
          return runEngineErrorResponse(
            request,
            this.env,
            "A server-issued turn bootstrap is required before execution",
            428,
            "TURN_BOOTSTRAP_REQUIRED",
          );
        }
        const identity = TurnScopeBootstrapSchema.parse(payload.identity);
        await this.ensureTurnToRunMapLoaded();
        const storedIdentity = this.turnRuntimeIdentities.get(identity.turnId);
        const storedRunId = this.turnToRunMap.get(identity.turnId);
        if (
          !storedIdentity ||
          storedRunId !== payload.runId ||
          storedIdentity.workspaceId !== workspaceId.data ||
          storedIdentity.sessionId !== payload.sessionId ||
          storedIdentity.threadId !== identity.threadId ||
          storedIdentity.runAttemptId !== identity.runAttemptId
        ) {
          return runEngineErrorResponse(
            request,
            this.env,
            "Turn bootstrap identity does not match the authorized execution scope",
            409,
            "TURN_SCOPE_MISMATCH",
          );
        }
        this.eventStream?.start(payload.runId);
        const { turnId, runAttemptId, threadId } = identity;
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
          workspaceId: workspaceId.data,
          runId: payload.runId,
          sessionId: payload.sessionId,
          repositoryContext: payload.input.repositoryContext,
        });
        const userMessageId = readLatestUserMessageId(payload.messages);
        editArtifactCoordinator.setMessageContext({
          userMessageId: userMessageId ?? undefined,
          sourceTurnId: userMessageId ?? undefined,
        });
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
              // Legacy RunEvent records remain a projection for internal
              // activity/artifact capture only. Kernel lifecycle events are
              // appended and streamed exclusively by the lifecycle store.
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
        this.interruptRegistry.register(turnId, async (reason) => {
          await runtimeRunner.interrupt(turnId, reason);
        });
        let executionResponse: Response;
        try {
          executionResponse = await runtimeRunner.execute({
            input: payload.input,
            messages: payload.messages as CoreMessage[],
            tools: runtimeTools,
            lifecycleEvents: kernelLifecycleEvents,
            turnId,
            runAttemptId,
            threadId,
            workspaceId: workspaceId.data,
          });
        } finally {
          this.interruptRegistry.unregister(turnId);
        }
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
          "X-Thread-Id": threadId,
          "X-Turn-Id": turnId,
          "X-Run-Attempt-Id": runAttemptId,
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
      reportBrainError(this.env, {
        request,
        operation: "run.engine.execute",
        error,
        context: {
          correlationId: payload.correlationId,
          runId: payload.runId,
          sessionId: payload.sessionId,
        },
      });
      return runEngineErrorResponse(
        request,
        this.env,
        "Runtime execution failed before the run could settle. Retry the request or narrow the task.",
        500,
        "RUNTIME_EXECUTION_FAILED",
      );
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

  private async ensureTurnToRunMapLoaded(): Promise<void> {
    if (this.turnToRunMapLoaded) {
      this.pruneStaleTurnMappings();
      return;
    }

    const raw = await this.ctx.storage.get<Record<string, string>>(
      RunEngineRequestHandler.TURN_MAP_STORAGE_KEY,
    );
    if (raw && typeof raw === "object") {
      for (const [turnId, runId] of Object.entries(raw)) {
        this.turnToRunMap.set(turnId, runId);
      }
    }
    const identities = await this.ctx.storage.get<
      Record<string, TurnRuntimeIdentity>
    >(RunEngineRequestHandler.TURN_IDENTITY_STORAGE_KEY);
    if (identities && typeof identities === "object") {
      for (const [turnId, identity] of Object.entries(identities)) {
        this.turnRuntimeIdentities.set(turnId, identity);
      }
    }

    this.turnToRunMapLoaded = true;
  }

  private async persistTurnToRunMap(): Promise<void> {
    const entries: Record<string, string> = {};
    for (const [turnId, runId] of this.turnToRunMap) {
      entries[turnId] = runId;
    }
    await this.ctx.storage.put(
      RunEngineRequestHandler.TURN_MAP_STORAGE_KEY,
      entries,
    );
    await this.ctx.storage.put(
      RunEngineRequestHandler.TURN_IDENTITY_STORAGE_KEY,
      Object.fromEntries(this.turnRuntimeIdentities),
    );
  }

  private async mapTurnToRun(
    turnId: string,
    runId: string,
    identity: TurnRuntimeIdentity,
  ): Promise<void> {
    this.turnToRunMap.set(turnId, runId);
    this.turnRuntimeIdentities.set(turnId, identity);
    this.pruneStaleTurnMappings();
    await this.persistTurnToRunMap();
  }

  private pruneStaleTurnMappings(): void {
    const maxCount = 10_000;
    if (this.turnToRunMap.size <= maxCount) {
      return;
    }
    const keys = [...this.turnToRunMap.keys()];
    const toDelete = keys.slice(0, this.turnToRunMap.size - maxCount);
    for (const key of toDelete) {
      this.turnToRunMap.delete(key);
      this.turnRuntimeIdentities.delete(key);
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

function sameTurnRuntimeIdentity(
  expected: TurnRuntimeIdentity,
  received: TurnRuntimeIdentity,
): boolean {
  return (
    expected.runId === received.runId &&
    expected.workspaceId === received.workspaceId &&
    expected.threadId === received.threadId &&
    expected.turnId === received.turnId &&
    expected.runAttemptId === received.runAttemptId &&
    expected.sessionId === received.sessionId
  );
}

function isTerminalLifecycleEvent(
  event: LifecycleEvent,
): event is Extract<
  LifecycleEvent,
  { type: "turn.completed" | "turn.failed" | "turn.interrupted" }
> {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.interrupted"
  );
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
