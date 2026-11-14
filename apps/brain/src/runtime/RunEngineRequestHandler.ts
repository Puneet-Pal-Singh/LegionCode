import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { CoreMessage, CoreTool } from "ai";
import { z } from "zod";
import type {
  LifecycleEventStore,
  TurnAdmissionRecord,
} from "@repo/persistence";
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
  EventSequenceSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  type LifecycleEvent,
  RunIdSchema,
  WorkspaceIdSchema,
  TurnScopeBootstrapRequestSchema,
  TurnScopeBootstrapSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
  CompactTurnRequestSchema,
  CompactTurnResponseSchema,
  type TurnId,
  type ProtocolError,
  workspaceIdFromExternalId,
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
} from "@legioncode/execution-engine/runtime";
import type { Env } from "../types/ai";
import { parseExecuteRunRequest } from "./parsing/RunEngineRequestParser";
import {
  SerializableToolDefinitionSchema,
  type ExecuteRunPayload,
} from "./parsing/ExecuteRunPayloadSchema";
import { scheduleClaimedInitialThreadTitle } from "../services/thread-titles/InitialThreadTitleScheduler";
import { prepareRuntimeExecutionResources } from "./RuntimeExecutionResources";
import { RunAdmissionService, settledAdmissionRejection } from "./RunAdmissionService";
import type { NativeAttemptObserver, NativePreparationCleanupReceipt } from "./RetainedNativeAttempt";
import { resolveNativeAdmissionExecutionInput } from "./NativeAdmissionExecutionInput";
import type { NativeProviderCredentialContext } from "../services/providers/NativeProviderCredentialResolver";
import {
  DomainError,
  isDomainError,
  mapDomainErrorToHttp,
} from "../domain/errors";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { mapRunExecutionErrorToDomain } from "./RunExecutionErrorMapper";
import {
  sanitizeLogText,
  sanitizeUnknownError,
} from "../core/security/LogSanitizer";
import { buildRunEngineRuntimeDebugPayload } from "../core/observability/runtime";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";
import { parseTraceparent } from "@repo/observability";
import { reportBrainError } from "../core/observability/BrainErrorReporter";
import {
  runEngineErrorResponse,
  runEngineJsonResponse,
  withRunEngineHeaders,
} from "./RunEngineHttpResponse";
import { withTurnAdmissionRepository } from "../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import { RunEngineCanonicalEventSink } from "./RunEngineCanonicalEventSink";
import {
  InMemoryRunInterruptRegistry,
  type RunInterruptRegistry,
} from "./RunInterruptRegistry";
import { settleOwnedStartupFailure } from "./RuntimeLifecycleSettlement";
import { acknowledgePersistedNativeStop } from "./PersistedNativeStop";
import {
  InMemoryRunContextCompactionRegistry,
  type RunContextCompactionRegistry,
} from "./RunContextCompactionRegistry";
import {
  InMemoryRunThreadInputRegistry,
  type RunThreadInputRegistry,
} from "./RunThreadInputRegistry";
import {
  InMemoryRunApprovalResolutionRegistry,
  type RunApprovalResolutionRegistry,
} from "./RunApprovalResolutionRegistry";
import {
  BrainWorkspaceIdSchema,
  RunInterruptIdentitySchema,
  RunInterruptRequestSchema,
  type RunInterruptRequest,
  type RunInterruptIdentity,
} from "./RunInterruptContract";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import { ChatMediaStore } from "../services/chat/ChatMediaStore";
import { resolveChatImageSettings } from "../services/chat/ChatImageSettings";
import { BrainLifecycleEventStore } from "../services/lifecycle/BrainLifecycleEventStore";
import {
  getCodingCoreToolRegistry,
  enforceCodingToolFloor,
} from "@legioncode/execution-engine/runtime";
import { RuntimeWorkspaceScopeResponseSchema } from "./RuntimeWorkspaceScope";
import {
  TaskCheckoutExecutionOrchestrator,
  type TaskCheckoutScopeResolutionPort,
} from "./task-workspaces/TaskCheckoutExecutionOrchestrator";

const ApprovalDecisionRequestSchema = z.object({
  runId: RunIdSchema,
  requestId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
});
const LifecycleApprovalDecisionRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
    grantScope: z.enum(["once", "matching_in_chat"]).optional(),
    decidedBy: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .superRefine((payload, context) => {
    if (payload.grantScope && payload.decision !== "approved") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Approval grants require an approved decision",
        path: ["grantScope"],
      });
    }
  });
const LifecycleEventsQuerySchema = z.object({
  turnId: TurnIdSchema,
  afterSequence: EventSequenceSchema.nullable(),
  limit: z.number().int().min(1).max(1_000),
});
const TurnDiffQuerySchema = z.object({ turnId: TurnIdSchema });
const RuntimeThreadInputRequestSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().trim().min(1).max(200),
  runId: RunIdSchema,
  workspaceId: BrainWorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  inputId: z.string().uuid(),
  clientInputId: z.string().trim().min(1).max(200),
  transcriptMessageId: z.string().trim().min(1).max(200),
  text: z.string().max(100_000),
  mediaRefs: z.array(ChatImageAttachmentRefSchema).max(8),
}).strict().refine((value) => value.text.trim().length > 0 || value.mediaRefs.length > 0, {
  message: "Provide text or at least one image.",
});
export interface RunEngineRequestLock {
  <T>(runId: string, operation: () => Promise<T>): Promise<T>;
  hasQueuedOrActiveRun: (runId: string) => boolean;
}

export interface CanonicalRunEventSink {
  persist(event: RunEvent, correlationId: string): Promise<void>;
}

export interface RunEngineRequestHandlerDependencies {
  canonicalEventSink?: CanonicalRunEventSink;
  lifecycleEventStore?: LifecycleEventStore;
  interruptRegistry?: RunInterruptRegistry;
  approvalResolutionRegistry?: RunApprovalResolutionRegistry;
  contextCompactionRegistry?: RunContextCompactionRegistry;
  threadInputRegistry?: RunThreadInputRegistry;
  taskCheckoutScopeResolver?: TaskCheckoutScopeResolutionPort;
}

// This is the existing DO scope entry, not an execution queue or lifecycle log.
const TurnRuntimeIdentitySchema = RunInterruptIdentitySchema.extend({
  // Existing saved entries may already use the canonical workspace alias.
  workspaceId: z.union([BrainWorkspaceIdSchema, WorkspaceIdSchema]),
  ownerUserId: z.string().min(1).optional(),
  revisionOfTurnId: TurnIdSchema.optional(),
  continuationOfTurnId: TurnIdSchema.optional(),
  originalPromptId: z.string().min(1).optional(),
  plannedExecutionClaimId: z.string().uuid().optional(),
  pendingInterruptReason: z.string().min(1).max(2_000).optional(),
}).strict();
type TurnRuntimeIdentity = z.infer<typeof TurnRuntimeIdentitySchema>;

function sameRuntimeAdmission(identity: TurnRuntimeIdentity, admission: TurnAdmissionRecord | null): admission is TurnAdmissionRecord {
  return admission !== null && admission.state === "admitted" && admission.userId === identity.ownerUserId &&
    admission.sessionId === identity.sessionId && admission.runId === identity.runId &&
    admission.workspaceId !== null && workspaceIdFromExternalId(admission.workspaceId) === workspaceIdFromExternalId(identity.workspaceId) &&
    admission.threadId === identity.threadId && admission.turnId === identity.turnId && admission.runAttemptId === identity.runAttemptId &&
    admission.revisionOfTurnId === (identity.revisionOfTurnId ?? null) &&
    admission.continuationOfTurnId === (identity.continuationOfTurnId ?? null) &&
    admission.originalPromptId === (identity.originalPromptId ?? null);
}

export class RunEngineRequestHandler {
  private readonly turnToRunMap = new Map<string, string>();
  private readonly turnRuntimeIdentities = new Map<
    string,
    TurnRuntimeIdentity
  >();
  private readonly interruptRegistry: RunInterruptRegistry;
  private readonly approvalResolutionRegistry: RunApprovalResolutionRegistry;
  private readonly contextCompactionRegistry: RunContextCompactionRegistry;
  private readonly threadInputRegistry: RunThreadInputRegistry;
  private turnToRunMapLoaded = false;

  private static readonly TURN_MAP_STORAGE_KEY = "turnToRunMap";
  private static readonly TURN_IDENTITY_STORAGE_KEY = "turnRuntimeIdentities";

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly withExecutionLock: RunEngineRequestLock,
    _removedEventStream?: never,
    private readonly dependencies: RunEngineRequestHandlerDependencies = {},
  ) {
    this.interruptRegistry =
      dependencies.interruptRegistry ?? new InMemoryRunInterruptRegistry();
    this.approvalResolutionRegistry =
      dependencies.approvalResolutionRegistry ??
      new InMemoryRunApprovalResolutionRegistry();
    this.contextCompactionRegistry =
      dependencies.contextCompactionRegistry ??
      new InMemoryRunContextCompactionRegistry();
    this.threadInputRegistry =
      dependencies.threadInputRegistry ?? new InMemoryRunThreadInputRegistry();
  }

  /** Same-DO wake reconciles only the recorded PG claim; it never resumes work. */
  async reconcileRuntimeClaims(): Promise<void> {
    await this.ensureTurnToRunMapLoaded();
    for (const identity of this.turnRuntimeIdentities.values()) {
      const claimId = identity.plannedExecutionClaimId;
      if (!claimId || !identity.ownerUserId || this.interruptRegistry.hasActiveOwner(identity.turnId)) continue;
      await this.withExecutionLock(identity.runId, async () => {
        if (this.interruptRegistry.hasActiveOwner(identity.turnId)) return;
        const admission = await withTurnAdmissionRepository(this.env, repository => repository.getByTurnId(identity.turnId));
        if (!sameRuntimeAdmission(identity, admission) || admission.executionState !== "running") return;
        // An exact claim CAS is the only authority to mark lost ownership.
        // Provider/tool/lease obligations remain unknown and unreleased.
        await withTurnAdmissionRepository(this.env, repository => repository.markRecoveryRequired({ turnId: identity.turnId, claimId }));
      });
    }
  }

  async handleLifecycleEventsRequest(request: Request): Promise<Response> {
    const input = parseLifecycleEventsQuery(request);
    if (!input.ok) {
      return runEngineErrorResponse(request, this.env, input.message, 400);
    }

    const replay = await this.createLifecycleEventStore().replay(input.value);
    return runEngineJsonResponse(request, this.env, replay);
  }

  async handleTurnDiffRequest(request: Request): Promise<Response> {
    const input = parseTurnDiffQuery(request);
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
    let payload: RunInterruptRequest;
    try {
      const body = await parseRequestBody(request, "run-interrupt");
      const validated = validateWithSchema<RunInterruptRequest>(
        body,
        RunInterruptRequestSchema,
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

    const store = this.createLifecycleEventStore();
    const admission = await withTurnAdmissionRepository(
      this.env,
      (repository) => repository.getByTurnId(payload.turnId),
    );
    if (
      !admission ||
      admission.state !== "admitted" ||
      admission.runId !== payload.runId ||
      admission.sessionId !== payload.sessionId ||
      admission.workspaceId !== payload.workspaceId ||
      admission.threadId !== payload.threadId ||
      admission.turnId !== payload.turnId ||
      admission.runAttemptId !== payload.runAttemptId
    ) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Interrupt identity does not match the durable admitted turn",
        409,
      );
    }

    const replayEvents = await readAllLifecycleEvents(store, payload.turnId);
    const terminalEvent = replayEvents.find(isTerminalLifecycleEvent);
    if (terminalEvent) {
      return runEngineJsonResponse(request, this.env, {
        runId: payload.runId,
        accepted: false,
        status: "settled",
        terminalEvent,
      });
    }

    await this.ensureTurnToRunMapLoaded();
    const { reason: _reason, ...interruptIdentity } = payload;
    const durableIdentity: TurnRuntimeIdentity = {
      ...interruptIdentity, ownerUserId: admission.userId,
      ...(admission.revisionOfTurnId ? { revisionOfTurnId: TurnIdSchema.parse(admission.revisionOfTurnId) } : {}),
      ...(admission.continuationOfTurnId ? { continuationOfTurnId: TurnIdSchema.parse(admission.continuationOfTurnId) } : {}),
      ...(admission.originalPromptId ? { originalPromptId: admission.originalPromptId } : {}),
    };
    const storedIdentity = this.turnRuntimeIdentities.get(payload.turnId);
    if (storedIdentity && !sameRuntimeAdmission({ ...storedIdentity, ownerUserId: storedIdentity.ownerUserId ?? admission.userId }, admission))
      return runEngineErrorResponse(request, this.env, "Interrupt scope does not match its runtime owner", 409);
    await this.mapTurnToRun(payload.turnId, payload.runId, {
      ...(storedIdentity ?? durableIdentity), ownerUserId: admission.userId, pendingInterruptReason: payload.reason,
    });

    const receipt = await acknowledgePersistedNativeStop({
      admission,
      hasActiveOriginal: () => this.interruptRegistry.hasActiveOwner(payload.turnId) || this.approvalResolutionRegistry.has(payload.turnId),
      requestOriginalStop: () => this.interruptRegistry.request(payload.turnId, payload.reason),
      hasQueuedOrActiveRun: () => this.withExecutionLock.hasQueuedOrActiveRun(payload.runId),
      underRunLock: operation => this.withExecutionLock(payload.runId, operation),
      readAdmission: () => withTurnAdmissionRepository(this.env, repository => repository.getByTurnId(payload.turnId)),
      readTerminal: async () => (await readAllLifecycleEvents(store, payload.turnId)).find(isTerminalLifecycleEvent),
      markRecoveryRequired: current => withTurnAdmissionRepository(this.env, repository =>
        repository.markRecoveryRequiredForUnownedStop({
          userId: current.userId, sessionId: current.sessionId, workspaceId: current.workspaceId!,
          runId: current.runId, threadId: current.threadId, turnId: current.turnId, runAttemptId: current.runAttemptId,
        })),
      reportUnresolved: () => console.warn(formatDiagnosticLogLine("run/runtime", "persisted-stop-delivery-unresolved", {
        runId: payload.runId, turnId: payload.turnId,
      })),
    });
    return runEngineJsonResponse(request, this.env, {
      runId: payload.runId,
      accepted: receipt.status === "interrupt_requested",
      ...receipt,
    });
  }

  async handleThreadInputSteerRequest(request: Request): Promise<Response> {
    let payload: z.infer<typeof RuntimeThreadInputRequestSchema>;
    try {
      payload = RuntimeThreadInputRequestSchema.parse(
        await parseRequestBody(request, "thread-input-steer"),
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid thread input", 400);
    }

    const admission = await withTurnAdmissionRepository(this.env, (repository) =>
      repository.getByTurnId(payload.turnId),
    );
    if (
      !admission || admission.state !== "admitted" ||
      admission.sessionId !== payload.sessionId || admission.userId !== payload.userId ||
      admission.runId !== payload.runId || admission.workspaceId !== payload.workspaceId ||
      admission.threadId !== payload.threadId || admission.runAttemptId !== payload.runAttemptId
    ) {
      return runEngineErrorResponse(request, this.env, "Steering identity does not match the admitted turn", 409, "target_superseded");
    }

    const history = await readAllLifecycleEvents(this.createLifecycleEventStore(), payload.turnId);
    const priorAcceptance = history.find((event) =>
      event.type === "turn.input.accepted" && event.payload.inputId === payload.inputId,
    );
    if (priorAcceptance?.type === "turn.input.accepted") {
      return runEngineJsonResponse(request, this.env, {
        status: "accepted",
        inputId: payload.inputId,
        clientInputId: payload.clientInputId,
        transcriptMessageId: payload.transcriptMessageId,
        targetTurnId: payload.turnId,
        targetRunAttemptId: payload.runAttemptId,
        acceptedSequence: priorAcceptance.sequence,
      });
    }

    if (!this.threadInputRegistry.has(payload.turnId)) {
      return runEngineErrorResponse(request, this.env, "Turn has no live input owner", 409, "turn_not_active");
    }
    const images = payload.mediaRefs.map((ref) => ref);
    const providerImages = [];
    if (images.length > 0) {
      if (!this.env.EDIT_ARTIFACTS) {
        return runEngineErrorResponse(request, this.env, "Chat image storage is unavailable", 503);
      }
      const mediaStore = new ChatMediaStore(this.env.EDIT_ARTIFACTS, resolveChatImageSettings(this.env));
      for (const ref of images) {
        providerImages.push(await mediaStore.getProviderImage({
          userId: payload.userId,
          sessionId: payload.sessionId,
          ref,
        }));
      }
    }
    const message = {
      role: "user",
      content: [
        ...(payload.text.trim() ? [{ type: "text", text: payload.text }] : []),
        ...providerImages,
      ],
    } as CoreMessage;
    let acceptedSequence: number;
    try {
      acceptedSequence = await this.threadInputRegistry.accept({
        turnId: payload.turnId,
        inputId: payload.inputId,
        clientInputId: payload.clientInputId,
        transcriptMessageId: payload.transcriptMessageId,
        message,
      });
    } catch {
      // Only the explicit owner check above proves a terminal/owner conflict.
      // Append and storage errors can happen after durable inbox admission, so
      // callers must retain the row and reconcile it by input ID.
      return runEngineErrorResponse(request, this.env, "Steering outcome is being reconciled", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
    }
    return runEngineJsonResponse(request, this.env, {
      status: "accepted",
      inputId: payload.inputId,
      clientInputId: payload.clientInputId,
      transcriptMessageId: payload.transcriptMessageId,
      targetTurnId: payload.turnId,
      targetRunAttemptId: payload.runAttemptId,
      acceptedSequence,
    });
  }

  async handleContextCompactionRequest(request: Request): Promise<Response> {
    let payload: z.infer<typeof CompactTurnRequestSchema>;
    try {
      payload = validateWithSchema(
        await parseRequestBody(request, "context-compaction"),
        CompactTurnRequestSchema,
        "context-compaction",
      );
    } catch {
      return runEngineErrorResponse(
        request,
        this.env,
        "Invalid compact payload",
        400,
      );
    }

    await this.ensureTurnToRunMapLoaded();
    const run = await new RunRepository(this.createRuntimeState()).getById(
      payload.runId,
    );
    const identity = this.turnRuntimeIdentities.get(payload.turnId);
    if (!run || !identity || !sameTurnRuntimeIdentity(identity, payload)) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Context compaction identity does not match the active run",
        409,
      );
    }
    const replayEvents = await readAllLifecycleEvents(
      this.createLifecycleEventStore(),
      payload.turnId,
    );
    const terminalEvent = replayEvents.find(isTerminalLifecycleEvent);
    if (terminalEvent) {
      return runEngineJsonResponse(
        request,
        this.env,
        CompactTurnResponseSchema.parse({
          turnId: payload.turnId,
          accepted: false,
          status: "failed",
          itemId: null,
          error: "Turn is already settled",
        }),
        409,
      );
    }
    if (!this.contextCompactionRegistry.has(payload.turnId)) {
      return runEngineJsonResponse(
        request,
        this.env,
        CompactTurnResponseSchema.parse({
          turnId: payload.turnId,
          accepted: false,
          status: "unsupported",
          itemId: null,
          error: "The active runtime is not ready for context compaction",
        }),
        409,
      );
    }
    try {
      await this.contextCompactionRegistry.request(payload.turnId);
      return runEngineJsonResponse(
        request,
        this.env,
        CompactTurnResponseSchema.parse({
          turnId: payload.turnId,
          accepted: true,
          status: "completed",
          itemId: null,
          error: null,
        }),
      );
    } catch (error) {
      return runEngineJsonResponse(
        request,
        this.env,
        CompactTurnResponseSchema.parse({
          turnId: payload.turnId,
          accepted: false,
          status: "failed",
          itemId: null,
          error:
            error instanceof Error
              ? error.message
              : "Context compaction failed",
        }),
        409,
      );
    }
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

    const lifecycleStore = this.createLifecycleEventStore();
    const lifecycleApproval = await findLifecycleApprovalEvents(
      lifecycleStore,
      payload.turnId,
      payload.approvalId,
    );
    if (lifecycleApproval.decided) {
      if (
        !isMatchingLifecycleApprovalDecision(
          lifecycleApproval.decided,
          payload.decision,
          payload.grantScope === "matching_in_chat"
            ? "matching_in_chat"
            : undefined,
        )
      ) {
        return runEngineErrorResponse(
          request,
          this.env,
          "Approval request was already resolved differently.",
          409,
        );
      }
      return runEngineJsonResponse(
        request,
        this.env,
        lifecycleApproval.decided,
      );
    }

    if (payload.grantScope === "matching_in_chat") {
      const identity = this.turnRuntimeIdentities.get(payload.turnId);
      if (
        !lifecycleApproval.requested ||
        !identity ||
        !isMatchingInChatGrantRequest(
          lifecycleApproval.requested,
          workspaceIdFromExternalId(identity.workspaceId),
        )
      ) {
        return runEngineErrorResponse(
          request,
          this.env,
          "This approval request does not allow a matching-in-chat grant.",
          409,
        );
      }
    }

    if (!this.approvalResolutionRegistry.has(payload.turnId)) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Approval cannot be resolved because its runtime turn is no longer active.",
        409,
      );
    }

    const approvalStore = new PermissionApprovalStore(runtimeState, runId);
    const pendingApproval = await approvalStore.getPendingRequest();
    if (!pendingApproval || pendingApproval.requestId !== payload.approvalId) {
      return runEngineErrorResponse(
        request,
        this.env,
        "No matching pending approval request",
        409,
      );
    }

    let delivered: boolean;
    try {
      delivered = await this.approvalResolutionRegistry.resolve(
        payload.turnId,
        payload.approvalId,
        {
          decision: payload.decision,
          grantScope:
            payload.grantScope === "matching_in_chat"
              ? "matching_in_chat"
              : undefined,
          decidedBy: null,
          reason: payload.reason ?? null,
        },
      );
    } catch (error) {
      return runEngineErrorResponse(
        request,
        this.env,
        error instanceof Error
          ? error.message
          : "Approval decision could not be delivered to the active runtime turn.",
        409,
      );
    }
    if (!delivered) {
      return runEngineErrorResponse(
        request,
        this.env,
        "Approval decision could not be delivered to the active runtime turn.",
        409,
      );
    }

    // RuntimeKernel owns canonical approval settlement. Persist the legacy
    // permission allowance only after the kernel has appended approval.decided
    // and woken its active loop; writing it first races the wait port and can
    // settle the turn before the canonical resolver receives the decision.
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
          : "Unable to persist lifecycle approval decision",
        mapApprovalResolutionErrorStatus(error),
      );
    }

    const decided = (
      await findLifecycleApprovalEvents(
        lifecycleStore,
        payload.turnId,
        payload.approvalId,
      )
    ).decided;
    if (!decided) {
      return runEngineErrorResponse(
        request,
        this.env,
        "The active runtime accepted the approval but did not append its lifecycle decision event.",
        500,
      );
    }
    return runEngineJsonResponse(request, this.env, decided);
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

        const existingScopes = [...this.turnRuntimeIdentities.values()].filter(
          (candidate) =>
            candidate.runId === input.runId &&
            candidate.sessionId === input.sessionId &&
            candidate.workspaceId === workspaceId,
        );
        const requestedTurnId = input.clientMessageId
          ? (input.admittedIdentity?.turnId ?? null)
          : null;
        const admittedIdentity = input.admittedIdentity;
        if (
          !input.clientMessageId ||
          !admittedIdentity ||
          admittedIdentity.workspaceId !== workspaceId ||
          (input.revisionOfTurnId ?? undefined) !==
            admittedIdentity.revisionOfTurnId
        ) {
          return runEngineErrorResponse(
            request,
            this.env,
            "A durable turn admission identity is required before runtime scope import.",
            409,
            "TURN_ADMISSION_REQUIRED",
          );
        }
        const existing = requestedTurnId
          ? this.turnRuntimeIdentities.get(requestedTurnId)
          : existingScopes.at(-1);
        if (existing) {
          const sessionMatch =
            !input.sessionId || existing.sessionId === input.sessionId;
          const workspaceMatch =
            !input.workspaceId ||
            existing.workspaceId === input.workspaceId ||
            // Brain's workspace scope may be a UUID; tolerate the server-owned
            // workspaceId when the caller-supplied scope is absent or empty.
            !input.workspaceId.trim();
          const identityMatch =
            existing.turnId === admittedIdentity.turnId &&
            existing.threadId === admittedIdentity.threadId &&
            existing.runAttemptId === admittedIdentity.runAttemptId &&
            existing.revisionOfTurnId === admittedIdentity.revisionOfTurnId;
          if (!sessionMatch || !workspaceMatch || !identityMatch) {
            if (requestedTurnId) {
              return runEngineErrorResponse(
                request,
                this.env,
                "A turn with this client message already exists for a different session or workspace.",
                409,
                "CLIENT_MESSAGE_ID_CONFLICT",
              );
            }
            return runEngineErrorResponse(
              request,
              this.env,
              "Turn scope identity does not match the active session or workspace.",
              409,
              "TURN_SCOPE_CONFLICT",
            );
          }
          return runEngineJsonResponse(
            request,
            this.env,
            TurnScopeBootstrapSchema.parse({
              workspaceId: existing.workspaceId,
              threadId: existing.threadId,
              turnId: existing.turnId,
              runAttemptId: existing.runAttemptId,
              ...(existing.revisionOfTurnId
                ? { revisionOfTurnId: existing.revisionOfTurnId }
                : {}),
            }),
            200,
          );
        }

        const identity = TurnScopeBootstrapSchema.parse(admittedIdentity);
        await this.mapTurnToRun(identity.turnId, input.runId, {
          ...identity,
          runId: input.runId,
          sessionId: input.sessionId,
          ownerUserId: input.userId,
        });
        return runEngineJsonResponse(
          request,
          this.env,
          identity,
          existing ? 200 : 201,
        );
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

    try {
      const checkout = await (
        this.dependencies.taskCheckoutScopeResolver ??
        new TaskCheckoutExecutionOrchestrator(this.env)
      ).resolveActiveCheckout(identity, `workspace-scope:${runId}`);
      return runEngineJsonResponse(
        request,
        this.env,
        RuntimeWorkspaceScopeResponseSchema.parse({
          ...identity,
          root: checkout.filesystemRoot,
        }),
      );
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
      throw error;
    }
  }

  async handleTurnScopeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runIdRaw = url.searchParams.get("runId");
    const sessionId = url.searchParams.get("sessionId");
    if (!runIdRaw || !sessionId?.trim()) {
      return runEngineErrorResponse(
        request,
        this.env,
        "runId and sessionId are required",
        400,
        "TURN_SCOPE_QUERY_INVALID",
      );
    }

    let runId: string;
    try {
      runId = validateWithSchema<string>(
        runIdRaw.trim(),
        RunIdSchema,
        "turn-scope",
      );
    } catch {
      return runEngineErrorResponse(request, this.env, "Invalid runId", 400);
    }

    await this.ensureTurnToRunMapLoaded();
    const identity = [...this.turnRuntimeIdentities.values()]
      .reverse()
      .find(
        (candidate) =>
          candidate.runId === runId && candidate.sessionId === sessionId.trim(),
      );
    if (!identity) {
      return runEngineErrorResponse(
        request,
        this.env,
        "No server-issued turn scope exists for this session and run",
        404,
        "TURN_SCOPE_NOT_FOUND",
      );
    }

    return runEngineJsonResponse(
      request,
      this.env,
      TurnScopeBootstrapSchema.parse({
        workspaceId: identity.workspaceId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
      }),
    );
  }

  async handleExecuteRequest(request: Request, observer?: NativeAttemptObserver): Promise<Response> {
    let executionClaim: { turnId: TurnId; claimId: string } | null = null;
    let startupInterruptReason: string | null = null;
    // This original creator has not invoked any resource/provider preparation.
    // Clear the receipt synchronously before handing capability to that owner.
    let preparationCleanup: NativePreparationCleanupReceipt | undefined = { kind: "no_exposure" };
    let retainedOwnerClaimed = false;
    let startupOwner = false;
    const attemptController = new AbortController();
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

    const nativeObserver = observer; // This continuation is the actual Native execution owner.
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
      // Establish the exact admitted startup owner before a queued execution
      // lock can hide Stop. This request never unregisters another owner.
      if (payload.identity && payload.userId) {
        const startupIdentity = TurnScopeBootstrapSchema.parse(payload.identity);
        const admission = await withTurnAdmissionRepository(this.env, repository => repository.getByTurnId(startupIdentity.turnId));
        const candidate = { ...startupIdentity, runId: payload.runId, sessionId: payload.sessionId, ownerUserId: payload.userId };
        if (sameRuntimeAdmission(candidate, admission)) {
          if (this.interruptRegistry.hasActiveOwner(startupIdentity.turnId))
            return runEngineErrorResponse(request, this.env, "This admitted turn already has an active startup or execution owner.", 409, "TURN_EXECUTION_ALREADY_CLAIMED");
          if (admission.executionState === "pending") {
            this.interruptRegistry.beginStartup(startupIdentity.turnId);
            startupOwner = true;
          }
        }
      }
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
        let storedIdentity = this.turnRuntimeIdentities.get(identity.turnId);
        let storedRunId = this.turnToRunMap.get(identity.turnId);
        if (!storedIdentity || !storedRunId) {
          const durableAdmission = await withTurnAdmissionRepository(
            this.env,
            (repository) => repository.getByTurnId(identity.turnId),
          );
          if (
            durableAdmission?.state === "admitted" &&
            durableAdmission.userId === payload.userId &&
            durableAdmission.sessionId === payload.sessionId &&
            durableAdmission.runId === payload.runId &&
            durableAdmission.workspaceId === workspaceId.data &&
            durableAdmission.threadId === identity.threadId &&
            durableAdmission.runAttemptId === identity.runAttemptId &&
            durableAdmission.revisionOfTurnId ===
              (identity.revisionOfTurnId ?? null)
          ) {
            await this.mapTurnToRun(identity.turnId, payload.runId, {
              ...identity,
              runId: payload.runId,
              sessionId: payload.sessionId,
              ownerUserId: payload.userId,
            });
            storedIdentity = this.turnRuntimeIdentities.get(identity.turnId);
            storedRunId = this.turnToRunMap.get(identity.turnId);
          }
        }
        if (
          !storedIdentity ||
          storedRunId !== payload.runId ||
          workspaceIdFromExternalId(storedIdentity.workspaceId) !== workspaceIdFromExternalId(workspaceId.data) ||
          storedIdentity.sessionId !== payload.sessionId ||
          (storedIdentity.ownerUserId !== undefined && storedIdentity.ownerUserId !== payload.userId) ||
          storedIdentity.threadId !== identity.threadId ||
          storedIdentity.runAttemptId !== identity.runAttemptId ||
          storedIdentity.revisionOfTurnId !== identity.revisionOfTurnId
        ) {
          return runEngineErrorResponse(
            request,
            this.env,
            "Turn bootstrap identity does not match the authorized execution scope",
            409,
            "TURN_SCOPE_MISMATCH",
          );
        }
        const { turnId, runAttemptId, threadId } = identity;
        if (!payload.userId) {
          return runEngineErrorResponse(
            request,
            this.env,
            "Authenticated user scope is required for execution claim",
            409,
            "RUN_SCOPE_MISMATCH",
          );
        }
        const pendingAdmission = await withTurnAdmissionRepository(this.env, repository => repository.getByTurnId(turnId));
        const recordedIdentity = this.turnRuntimeIdentities.get(turnId)!;
        const claimId = recordedIdentity.plannedExecutionClaimId ?? crypto.randomUUID();
        if (sameRuntimeAdmission({ ...recordedIdentity, ownerUserId: payload.userId }, pendingAdmission) && pendingAdmission.executionState === "pending") {
          // Persist intent BEFORE the PG claim. A crash on either side can only
          // reconcile this ID; a replay cannot overwrite a live/recovery owner.
          this.turnRuntimeIdentities.set(turnId, TurnRuntimeIdentitySchema.parse({
            ...recordedIdentity, ownerUserId: payload.userId, plannedExecutionClaimId: claimId,
          }));
          await this.persistTurnToRunMap();
        }
        const claimable = sameRuntimeAdmission({ ...recordedIdentity, ownerUserId: payload.userId }, pendingAdmission) && pendingAdmission.executionState === "pending";
        const claimResult = claimable ? await withTurnAdmissionRepository(
          this.env,
          (repository) =>
            repository.claimExecution({
              turnId,
              runAttemptId,
              runId: payload.runId,
              sessionId: payload.sessionId,
              userId: payload.userId!,
              workspaceId: workspaceId.data,
              threadId,
              claimId,
            }),
        ) : {
          status: !sameRuntimeAdmission({ ...recordedIdentity, ownerUserId: payload.userId }, pendingAdmission) ? "conflict" as const
            : pendingAdmission.executionState === "settled" ? "settled" as const
            : pendingAdmission.executionState === "recovery_required" ? "recovery_required" as const : "already_claimed" as const,
          admission: pendingAdmission,
        };
        if (claimResult.status !== "claimed") {
          const rejected = claimResult.status === "settled" && claimResult.admission?.workspaceId
            ? settledAdmissionRejection({ userId: claimResult.admission.userId, workspaceId: claimResult.admission.workspaceId,
                sessionId: claimResult.admission.sessionId, runId: claimResult.admission.runId,
                threadId: claimResult.admission.threadId, turnId: claimResult.admission.turnId,
                runAttemptId: claimResult.admission.runAttemptId }) : undefined;
          const recovery =
            claimResult.status === "already_claimed" ||
            claimResult.status === "recovery_required";
          return runEngineErrorResponse(
            request,
            this.env,
            recovery
              ? "This admitted turn already has an execution claim and requires recovery review."
              : "This turn is already settled or does not match its durable admission.",
            409,
            recovery
              ? "TURN_EXECUTION_ALREADY_CLAIMED"
              : "TURN_EXECUTION_NOT_CLAIMABLE",
            rejected ? { executionRejection: rejected } : undefined,
          );
        }
        executionClaim = { turnId, claimId };
        if (!startupOwner) {
          this.interruptRegistry.beginStartup(turnId);
          startupOwner = true;
        }
        if (!claimResult.admission) throw new Error("Claimed execution has no durable admission receipt");
        const claimedAdmission = Object.freeze({ ...claimResult.admission });
        // This owner instantiates NativeRunner regardless of an input harness label.
        // A genuine delegated path must dispatch to its own owner before this boundary.
        const nativeCredentials: NativeProviderCredentialContext = Object.freeze({
          binding: claimedAdmission.nativeProviderBinding,
          scope: Object.freeze({
            userId: claimedAdmission.userId, workspaceId: claimedAdmission.workspaceId!, sessionId: claimedAdmission.sessionId,
            threadId: claimedAdmission.threadId, runId: claimedAdmission.runId, turnId: claimedAdmission.turnId,
            runAttemptId: claimedAdmission.runAttemptId,
          }),
        });
        const effectivePayload: ExecuteRunPayload = { ...payload,
          input: resolveNativeAdmissionExecutionInput(payload.input, nativeCredentials, payload.correlationId) };
        await new RunAdmissionService(this.env).claimAttempt(runAttemptId, payload.admissionLease, claimId, payload.correlationId);
        retainedOwnerClaimed = true;
        nativeObserver?.claimed(Object.freeze({
          admission: claimedAdmission, correlationId: payload.correlationId, claimId,
          admissionLease: payload.admissionLease ? Object.freeze({ ...payload.admissionLease }) : undefined,
        }));
        startupInterruptReason = this.turnRuntimeIdentities.get(turnId)?.pendingInterruptReason ??
          this.interruptRegistry.takePendingRequest(turnId);
        if (startupInterruptReason) {
          attemptController.abort(new DOMException("Run cancelled", "AbortError"));
          // This creator has not called the resource preparation owner at all.
          // This is factual no-exposure, never an inference from an Error.
          preparationCleanup = { kind: "no_exposure" };
          throw new DOMException("Run cancelled before Native preparation", "AbortError");
        }
        const runtimeState = this.createRuntimeState();
        preparationCleanup = undefined;
        const resources = await prepareRuntimeExecutionResources(this.ctx, this.env, effectivePayload, nativeCredentials, receipt => { preparationCleanup = receipt; });
        const taskCheckoutLifecycle = resources.checkoutLifecycle;
        const editArtifactCoordinator = resources.artifacts;
        let titleOperation: Promise<unknown> | undefined;
        let providerDrained = false;
        let bodyDrained = false;
        let artifactsSettled = false;
        let checkoutSettled = taskCheckoutLifecycle === undefined;
        try {
          const userMessageId = readLatestUserMessageId(effectivePayload.messages);
          editArtifactCoordinator?.setMessageContext({ userMessageId: userMessageId ?? undefined });
          const runtimeRunner = new RuntimeKernelNativeRunner(runtimeState, {
            env: this.env, sessionId: effectivePayload.sessionId, runId: effectivePayload.runId, userId: effectivePayload.userId,
            correlationId: effectivePayload.correlationId, requestOrigin: effectivePayload.requestOrigin,
          }, resources.agent, resources.runEngineDeps);
          const runtimeTools = resources.workspace ? toRuntimeCoreTools(effectivePayload.tools) : {};
          const hookOrchestration = resources.hooks;
          this.threadInputRegistry.register(turnId, async (threadInput) =>
            await runtimeRunner.acceptThreadInput(threadInput),
          );
          const pendingInterruptReason = this.interruptRegistry.register(
            turnId,
            async (reason) => {
              startupInterruptReason = reason;
              attemptController.abort(new DOMException("Run cancelled", "AbortError"));
              await runtimeRunner.interrupt(turnId, reason);
            },
          );
          if (pendingInterruptReason) {
            startupInterruptReason = pendingInterruptReason;
            attemptController.abort(new DOMException("Run cancelled", "AbortError"));
            await runtimeRunner.interrupt(turnId, pendingInterruptReason);
          }
          this.approvalResolutionRegistry.register(
            turnId,
            async (approvalId, resolution) => {
              await runtimeRunner.resolveApproval(
                turnId,
                approvalId,
                resolution,
              );
            },
          );
          this.contextCompactionRegistry.register(turnId, async () => {
            await runtimeRunner.compact(turnId);
          });
          if (nativeObserver && resources.runEngineDeps.aiService && !attemptController.signal.aborted) {
            await scheduleClaimedInitialThreadTitle(this.env, {
              admission: claimedAdmission, identity, prompt: effectivePayload.input.prompt,
              ...(effectivePayload.input.providerTransport && effectivePayload.input.providerEndpoint ? {
                providerRuntimeRoute: {
                  providerId: effectivePayload.input.providerId!, modelId: effectivePayload.input.modelId!,
                  transport: effectivePayload.input.providerTransport, endpoint: effectivePayload.input.providerEndpoint,
                },
              } : {}),
              modelCapabilities: effectivePayload.input.metadata?.modelCapabilities,
              execution: Object.freeze({ service: resources.runEngineDeps.aiService,
                scope: nativeCredentials.scope, signal: attemptController.signal }),
              owner: { waitUntil: operation => {
                if (titleOperation) throw new Error("Native title operation was registered twice");
                titleOperation = operation;
                void operation.catch(() => undefined);
              } },
            });
          }
          // Kernel observers can settle before the original provider body. Keep
          // this attempt's checkout and execution ownership until that body drains.
          const executionResponse = await runtimeRunner.execute({
            input: effectivePayload.input,
            messages: effectivePayload.messages as CoreMessage[],
            tools: runtimeTools,
            lifecycleEvents: this.createLifecycleEventStore(),
            hookOrchestration,
            turnId,
            runAttemptId,
            threadId,
            workspaceId: workspaceId.data,
            revisionOfTurnId: identity.revisionOfTurnId,
            continuationOfTurnId: identity.continuationOfTurnId,
            originalPromptId: identity.originalPromptId,
            workspace: resources.workspace,
          }).finally(async () => {
            await titleOperation;
            await resources.drainProviderRequests();
            providerDrained = true;
          }).then(async response => {
            if (!nativeObserver) return response;
            // This original response producer stays inside the DO attempt; an
            // admission ACK is never mistaken for its body having completed.
            const bytes = await response.arrayBuffer();
            bodyDrained = true;
            return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
          }, error => {
            bodyDrained = true; // Rejected execution produced no response body.
            throw error;
          });
          console.log(
            formatDiagnosticLogLine("run/runtime", "engine-executed", {
              correlationId: effectivePayload.correlationId,
              runId: effectivePayload.runId,
              sessionId: effectivePayload.sessionId,
              responseStatus: executionResponse.status,
            }),
          );

          const persistedAssistantMessageId = await withTranscriptRepository(
            this.env,
            (repository) =>
              repository.getCanonicalAssistantMessageId?.({
                sessionId: effectivePayload.sessionId,
                userId: effectivePayload.userId!,
                turnId,
                phase: "final_answer",
              }) ?? Promise.resolve(null),
          );
          console.log(
            formatDiagnosticLogLine("run/runtime", "post-execution-handled", {
              correlationId: effectivePayload.correlationId,
              runId: effectivePayload.runId,
              sessionId: effectivePayload.sessionId,
              assistantMessageId: persistedAssistantMessageId,
            }),
          );
          if (persistedAssistantMessageId) {
            editArtifactCoordinator?.setMessageContext({
              assistantMessageId: persistedAssistantMessageId,
            });
          }
          await editArtifactCoordinator?.waitForPendingCapture();
          artifactsSettled = true;
          const lifecycleEvents = await readAllLifecycleEvents(
            this.createLifecycleEventStore(),
            turnId,
          );
          const terminalLifecycleEvent = lifecycleEvents.find(
            isTerminalLifecycleEvent,
          );
          if (!terminalLifecycleEvent) {
            throw new DomainError(
              "RUNTIME_TERMINAL_SETTLEMENT_MISSING",
              "Runtime completed without a canonical terminal lifecycle event.",
              502,
              false,
              effectivePayload.correlationId,
            );
          }
          await taskCheckoutLifecycle?.settle(
            terminalLifecycleEvent.type === "turn.completed"
              ? { status: "settled" }
              : {
                  status: "failed",
                  failureCode:
                    terminalLifecycleEvent.type === "turn.interrupted"
                      ? "RUNTIME_TURN_INTERRUPTED"
                      : "RUNTIME_TERMINAL_FAILURE",
                },
          );
          checkoutSettled = true;
          console.log(
            formatDiagnosticLogLine("run/runtime", "artifacts-settled", {
              correlationId: effectivePayload.correlationId,
              runId: effectivePayload.runId,
              sessionId: effectivePayload.sessionId,
            }),
          );

          return withRunEngineHeaders(request, this.env, executionResponse, {
            "X-Thread-Id": threadId,
            "X-Turn-Id": turnId,
            "X-Run-Attempt-Id": runAttemptId,
          });
        } catch (error) {
          if (taskCheckoutLifecycle && !taskCheckoutLifecycle.isSettled) {
            try {
              await taskCheckoutLifecycle?.settle({
                status: "failed",
                failureCode: "RUN_PIPELINE_FAILED",
              });
              checkoutSettled = true;
            } catch {
              throw new DomainError(
                "TASK_CHECKOUT_SETTLEMENT_FAILED",
                "The task failed and its isolated checkout could not be settled. Retry after capacity recovery.",
                503,
                true,
                effectivePayload.correlationId,
                {
                  checkoutId: resources.checkoutId,
                  runAttemptId,
                },
              );
            }
          }
          throw error;
        } finally {
          try {
            await titleOperation;
            await resources.drainProviderRequests();
            providerDrained = true;
            if (!artifactsSettled) {
              await editArtifactCoordinator?.waitForPendingCapture();
              artifactsSettled = true;
            }
            await taskCheckoutLifecycle?.release();
            // A void checkout/session release (including HTTP 404) proves no
            // physical closure. Repository Plan also acquired that owner, so
            // retain its grant until an exact cleanup/retention receipt exists.
            const physicalResourcesClosed = !resources.workspace && taskCheckoutLifecycle === undefined;
            if (providerDrained && bodyDrained && artifactsSettled && checkoutSettled && physicalResourcesClosed) {
              nativeObserver?.cleanupSettled();
            }
          } finally {
            startupInterruptReason =
              this.interruptRegistry.takePendingRequest(turnId) ??
              startupInterruptReason;
            this.interruptRegistry.unregister(turnId);
            this.approvalResolutionRegistry.unregister(turnId);
            this.contextCompactionRegistry.unregister(turnId);
            this.threadInputRegistry.unregister(turnId);
          }
        }
      });
    } catch (error: unknown) {
      const domainError = mapRunExecutionErrorToDomain(
        error,
        payload.correlationId,
      );
      const claimedExecution = executionClaim as {
        turnId: TurnId;
        claimId: string;
      } | null;
      if (claimedExecution) {
        startupInterruptReason =
          this.interruptRegistry.takePendingRequest(claimedExecution.turnId) ??
          startupInterruptReason;
        this.interruptRegistry.unregister(claimedExecution.turnId);
        try {
          const identity = payload.identity;
          if (identity && payload.userId && preparationCleanup?.kind === "no_exposure") {
            await settleOwnedStartupFailure({
              disposition: preparationCleanup,
              store: this.createLifecycleEventStore(),
              claim: claimedExecution,
              identity: {
                turnId: identity.turnId,
                runAttemptId: identity.runAttemptId,
                threadId: identity.threadId,
                workspaceId: workspaceIdFromExternalId(identity.workspaceId),
                admittedWorkspaceId: identity.workspaceId,
                ...(identity.revisionOfTurnId
                  ? { revisionOfTurnId: identity.revisionOfTurnId }
                  : {}),
                ...(identity.continuationOfTurnId
                  ? { continuationOfTurnId: identity.continuationOfTurnId }
                  : {}),
                ...(identity.originalPromptId
                  ? { originalPromptId: identity.originalPromptId }
                  : {}),
                userId: payload.userId,
                sessionId: payload.sessionId,
                runId: payload.runId,
                correlationId: payload.correlationId,
              },
              markRecoveryRequired: (claim) =>
                withTurnAdmissionRepository(this.env, (repository) =>
                  repository.markRecoveryRequired(claim),
                ),
              readAdmission: () =>
                withTurnAdmissionRepository(this.env, (repository) =>
                  repository.getByTurnId(claimedExecution.turnId),
                ),
              interruptReason: startupInterruptReason,
              failure: toStartupLifecycleFailure(
                error,
                domainError,
                payload.correlationId,
              ),
            });
          } else {
            await withTurnAdmissionRepository(this.env, (repository) =>
              repository.markRecoveryRequired(claimedExecution),
            );
          }
        } catch (recoveryError) {
          console.error(
            "Failed to settle an owned execution claim",
            recoveryError,
          );
        }
      }
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
    } finally {
      // This receipt comes from the preparation owner, after known no-exposure
      // or successful compensation. An arbitrary preparation Error grants nothing.
      if (preparationCleanup && executionClaim && retainedOwnerClaimed) nativeObserver?.cleanupSettled();
      if (startupOwner && payload.identity) this.interruptRegistry.unregister(payload.identity.turnId);
    }
  }

  private createRuntimeState() {
    return tagRuntimeStateSemantics(
      this.ctx as unknown as LegacyDurableObjectState,
      "do",
    );
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
      for (const [turnId, value] of Object.entries(identities)) {
        const identity = TurnRuntimeIdentitySchema.parse(value);
        if (identity.turnId !== turnId || this.turnToRunMap.get(turnId) !== identity.runId)
          throw new Error("Stored runtime scope identity is inconsistent");
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
    this.turnRuntimeIdentities.set(turnId, TurnRuntimeIdentitySchema.parse(identity));
    this.pruneStaleTurnMappings();
    await this.persistTurnToRunMap();
  }

  private pruneStaleTurnMappings(): void {
    const maxCount = 10_000;
    if (this.turnToRunMap.size <= maxCount) {
      return;
    }
    // An unresolved claim/Stop marker is ownership evidence, not disposable
    // scope history. Liveness or a history-size limit cannot retire it.
    const keys = [...this.turnToRunMap.keys()].filter(turnId => {
      const identity = this.turnRuntimeIdentities.get(turnId);
      return !identity?.plannedExecutionClaimId && !identity?.pendingInterruptReason;
    });
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


function toStartupLifecycleFailure(
  error: unknown,
  domainError: DomainError | null,
  correlationId: string,
): ProtocolError {
  const message = sanitizeLogText(
    domainError?.message ?? sanitizeUnknownError(error),
  ).slice(0, 10_000);
  return {
    code: "workspace_prepare_failed",
    message: message || "Runtime setup failed before execution began.",
    retryable: domainError?.retryable ?? true,
    correlationId: correlationId || null,
    details: domainError
      ? {
          domainCode: sanitizeLogText(domainError.code),
          httpStatus: domainError.status,
        }
      : null,
  };
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

function parseTurnDiffQuery(
  request: Request,
): ParsedLifecycleQuery<z.infer<typeof TurnDiffQuerySchema>> {
  const url = new URL(request.url);
  return parseLifecycleQuery(
    {
      turnId: readTurnId(url),
    },
    TurnDiffQuerySchema,
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
  const match = pathname.match(/^\/turns\/([^/]+)\/lifecycle-events$/);
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

async function readAllLifecycleEvents(
  store: LifecycleEventStore,
  turnId: string,
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  let afterSequence: number | null = null;
  for (;;) {
    const replay = await store.replay({
      turnId: TurnIdSchema.parse(turnId),
      afterSequence,
      limit: 1_000,
    });
    events.push(...replay.events);
    if (replay.events.length < 1_000 || replay.nextSequence === null)
      return events;
    if (replay.nextSequence === afterSequence) {
      throw new Error(
        `Lifecycle replay cursor did not advance for turn ${turnId}`,
      );
    }
    afterSequence = replay.nextSequence;
  }
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
    message.includes("does not match pending request") ||
    message.includes("already resolved differently")
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

async function findLifecycleApprovalEvents(
  store: LifecycleEventStore,
  turnId: string,
  approvalId: string,
): Promise<{
  requested: Extract<LifecycleEvent, { type: "approval.requested" }> | null;
  decided: Extract<LifecycleEvent, { type: "approval.decided" }> | null;
}> {
  let afterSequence: number | null = null;
  let requested: Extract<
    LifecycleEvent,
    { type: "approval.requested" }
  > | null = null;
  let decided: Extract<LifecycleEvent, { type: "approval.decided" }> | null =
    null;
  for (;;) {
    const replay = await store.replay({
      turnId: TurnIdSchema.parse(turnId),
      afterSequence,
      limit: 1_000,
    });
    for (const event of replay.events) {
      if (
        event.type !== "approval.requested" &&
        event.type !== "approval.decided"
      ) {
        continue;
      }
      if (event.approvalId !== approvalId) continue;
      if (event.type === "approval.requested") requested = event;
      if (event.type === "approval.decided") decided = event;
    }
    if (
      replay.events.length < 1_000 ||
      replay.nextSequence === null ||
      replay.nextSequence === afterSequence
    ) {
      break;
    }
    afterSequence = replay.nextSequence;
  }
  return { requested, decided };
}

function isMatchingInChatGrantRequest(
  event: Extract<LifecycleEvent, { type: "approval.requested" }>,
  workspaceId: string,
): boolean {
  const payload = event.payload;
  if (
    !Array.isArray(payload.options) ||
    !payload.options.some(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        "id" in option &&
        option.id === "allow_matching_in_chat",
    )
  ) {
    return false;
  }
  const metadata = payload.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return false;
  }
  return (
    typeof metadata.grantMatcherKey === "string" &&
    metadata.grantMatcherKey.length > 0 &&
    metadata.grantWorkspaceId === workspaceId
  );
}

function isMatchingLifecycleApprovalDecision(
  event: LifecycleEvent,
  decision: z.infer<typeof ApprovalDecisionSchema>,
  grantScope?: "matching_in_chat",
): boolean {
  return (
    event.type === "approval.decided" &&
    "status" in event.payload &&
    event.payload.status === decision &&
    (event.payload.grantScope ?? "once") === (grantScope ?? "once")
  );
}
