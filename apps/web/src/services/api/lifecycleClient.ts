import {
  applyHookAuditLifecycleEvent,
  buildHookSettingsAuditReadModel,
  createPlatformClient,
  createPlatformHttpTransport,
  createHookAuditProjection,
  HookInvocationAuditEventSchema,
  LifecycleEventSchema,
  type ApprovalId,
  type EventId,
  type EventIdempotencyKey,
  type FollowLifecycleRequest,
  type GetTurnDiffRequest,
  type InterruptTurnRequest,
  type InterruptTurnResponse,
  type CompactTurnRequest,
  type CompactTurnResponse,
  type HookInvocationAuditEvent,
  type HookAuditProjectionState,
  type HookSettingsAuditReadModel,
  type ItemId,
  type ItemKind,
  type LifecycleEvent,
  type PlatformClient,
  type PlatformClientOperationOptions,
  type RunAttemptId,
  type ReplayLifecycleEventsRequest,
  type ReplayLifecycleEventsResponse,
  type StartTurnRequest,
  type SubmitLifecycleApprovalRequest,
  type SubmitUserInputResponseRequest,
  type ThreadId,
  type TurnDiffPayload,
  type TurnId,
} from "@repo/platform-client-sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints.js";

export {
  applyHookAuditLifecycleEvent,
  buildHookSettingsAuditReadModel,
  createHookAuditProjection,
  HookInvocationAuditEventSchema,
  LifecycleEventSchema,
  type ApprovalId,
  type EventId,
  type EventIdempotencyKey,
  type HookInvocationAuditEvent,
  type HookAuditProjectionState,
  type HookSettingsAuditReadModel,
  type ItemId,
  type ItemKind,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnDiffPayload,
  type TurnId,
};

export interface LifecycleClient {
  startTurn(
    request: StartTurnRequest,
    options?: PlatformClientOperationOptions,
  ): ReturnType<PlatformClient["startTurn"]>;
  followTurnLifecycle(
    request: FollowLifecycleRequest,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<LifecycleEvent>;
  replayLifecycleEvents(
    request: ReplayLifecycleEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayLifecycleEventsResponse>;
  submitApproval(
    request: SubmitLifecycleApprovalRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<LifecycleEvent>;
  submitUserInputResponse(
    request: SubmitUserInputResponseRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<LifecycleEvent>;
  getTurnDiff(
    request: GetTurnDiffRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<TurnDiffPayload | null>;
  interruptTurn(
    request: InterruptTurnRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<InterruptTurnResponse>;
  compactTurn(
    request: CompactTurnRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<CompactTurnResponse>;
}

export function createLifecycleClient(
  platformClient: PlatformClient = createDefaultPlatformClient(),
): LifecycleClient {
  return new PlatformLifecycleClient(platformClient);
}

class PlatformLifecycleClient implements LifecycleClient {
  constructor(private readonly platformClient: PlatformClient) {}

  startTurn(
    request: StartTurnRequest,
    options?: PlatformClientOperationOptions,
  ) {
    return this.platformClient.startTurn(request, options);
  }

  followTurnLifecycle(
    request: FollowLifecycleRequest,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<LifecycleEvent> {
    return this.platformClient.followTurnLifecycle(request, options);
  }

  replayLifecycleEvents(
    request: ReplayLifecycleEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayLifecycleEventsResponse> {
    return this.platformClient.replayLifecycleEvents(request, options);
  }

  submitApproval(
    request: SubmitLifecycleApprovalRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<LifecycleEvent> {
    return this.platformClient.submitLifecycleApproval(request, options);
  }

  submitUserInputResponse(
    request: SubmitUserInputResponseRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<LifecycleEvent> {
    return this.platformClient.submitUserInputResponse(request, options);
  }

  getTurnDiff(
    request: GetTurnDiffRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<TurnDiffPayload | null> {
    return this.platformClient.getTurnDiff(request, options);
  }

  interruptTurn(
    request: InterruptTurnRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<InterruptTurnResponse> {
    return this.platformClient.interruptTurn(request, options);
  }

  compactTurn(
    request: CompactTurnRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<CompactTurnResponse> {
    return this.platformClient.compactTurn(request, options);
  }
}

function createDefaultPlatformClient(): PlatformClient {
  return createPlatformClient(
    createPlatformHttpTransport({
      baseUrl: getBrainHttpBase(),
    }),
  );
}
