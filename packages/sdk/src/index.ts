export { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
export {
  createProviderAppServerTransport,
  type ProviderAppServerTransportOptions,
} from "./providers/app-server-transport.js";
export {
  AppServerClientError,
  createAppServerClient,
  type AppServerClient,
  type AppServerClientOptions,
  type AppServerTransport,
  type WorkspaceGrantSource,
  type ArtifactReviewLookupResult,
} from "./platform/app-server-client.js";
export { ConversationScopeHttpError } from "./platform/conversation-scope-error.js";
export type { ConversationScope } from "./platform/conversation-scope.js";
export {
  acquireSubmissionAttempt,
  findSubmissionAttempt,
  finishSubmissionAttempt,
  freezeSubmissionWireBody,
  retainSubmissionReservation,
  retireSessionSubmissionAttempts,
  retireSubmissionIntent,
} from "./platform/submission-attempt-registry.js";
export type {
  SubmissionAttempt,
  SubmissionOutcome,
} from "./platform/submission-attempt-registry.js";
export { hasCanonicalLifecycleEvidence } from "./platform/submission-evidence.js";
export {
  AppServerTransportError,
  createAppServerHttpTransport,
  type AppServerHttpTransportOptions,
} from "./platform/app-server-http-transport.js";
export {
  DefaultPlatformClient,
  createPlatformClient,
} from "./platform/client.js";
export {
  PlatformClientContractError,
  PlatformClientOperationError,
  normalizePlatformClientOperationError,
  parsePlatformOperationErrorCode,
  parseProtocolErrorEnvelope,
  type PlatformClientOperationErrorCode,
} from "./platform/errors.js";
export {
  createPlatformHttpTransport,
  type PlatformHttpTransportOptions,
} from "./platform/http-transport.js";
export {
  HookInvocationAuditEventSchema,
  type HookInvocationAuditEvent,
} from "@repo/hook-protocol";
export {
  HookAuditProjectionError,
  applyHookAuditLifecycleEvent,
  buildHookSettingsAuditReadModel,
  createHookAuditProjection,
  projectHookAuditLifecycleEvent,
  replayHookAuditLifecycleEvents,
  type HookAuditProjectionState,
  type HookSettingsAuditReadModel,
} from "./platform/hook-audit-projection.js";
export {
  LifecycleEventSchema,
  ApprovalIdSchema,
  EventIdSchema,
  ItemIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  TurnScopeBootstrapRequestSchema,
  TurnScopeBootstrapSchema,
  TurnScopeReadQuerySchema,
  WorkspaceIdSchema,
  ContextBudgetSnapshotSchema,
  UsageCostSnapshotSchema,
  TurnDiffPayloadSchema,
  type ApprovalId,
  type EventId,
  type EventIdempotencyKey,
  type ItemId,
  type ItemKind,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnDiffPayload,
  type TurnId,
  type TurnScopeBootstrap,
  type TurnScopeReadQuery,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";
export {
  turnIdFromRunId,
  turnSeedFromLatestUserMessage,
} from "@repo/platform-protocol/lifecycle-turn-routing";
export { buildDiffContentFromTurnDiff } from "./platform/turn-diff-patch.js";
export {
  EnqueueThreadInputCommandSchema,
  ListThreadInputsCommandSchema,
  RemoveThreadInputCommandSchema,
  ResumeTurnCommandSchema,
  ResumeTurnReceiptSchema,
  StartQueuedThreadInputCommandSchema,
  SteerQueuedThreadInputCommandSchema,
  SteerTurnCommandSchema,
  ThreadInputCommandSchema,
  ThreadInputConfigurationSchema,
  ThreadInputContentSchema,
  ThreadInputImageSchema,
  ThreadInputQueueItemSchema,
  ThreadInputQueueSnapshotSchema,
  ThreadInputReceiptSchema,
  ThreadInputUpdateContentSchema,
  UpdateThreadInputCommandSchema,
  WorkspaceScopeIdSchema,
  type ResumeTurnReceipt,
  type ThreadInputCommand,
  type ThreadInputQueueItem,
  type ThreadInputQueueSnapshot,
  type ThreadInputReceipt,
} from "@repo/platform-protocol";
export type {
  EnqueueThreadInputCommand,
  ListThreadInputsCommand,
  RemoveThreadInputCommand,
  ResumeTurnCommand,
  StartQueuedThreadInputCommand,
  SteerQueuedThreadInputCommand,
  SteerTurnCommand,
  UpdateThreadInputCommand,
} from "./platform/conversation-input-types.js";
export {
  followLifecycleEvents,
  isRetryableLifecycleTransportError,
  replayLifecycleEventsWithRetry,
} from "./platform/lifecycle-continuation.js";
export {
  ConversationHistoryReadError,
  parseConversationHistoryPage,
  readConversationHistory,
  type ConversationHistoryPage,
  type ConversationHistoryReadOptions,
  type ConversationHistoryReadResult,
} from "./platform/conversation-history.js";
export {
  LifecycleContinuationError,
  createLifecycleOrderingState,
  type LifecycleContinuationErrorCode,
  type LifecycleOrderingState,
} from "./platform/lifecycle-ordering.js";
export {
  FollowLifecycleRequestSchema,
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  InterruptTurnRequestSchema,
  InterruptTurnResponseSchema,
  CompactTurnRequestSchema,
  CompactTurnResponseSchema,
  ReplayLifecycleEventsRequestSchema,
  ReplayLifecycleEventsResponseSchema,
  StartTurnRequestSchema,
  StartTurnResponseSchema,
  SubmitLifecycleApprovalRequestSchema,
  SubmitUserInputResponseRequestSchema,
  type FollowLifecycleRequest,
  type GetTurnDiffRequest,
  type GetTurnDiffResponse,
  type InterruptTurnRequest,
  type InterruptTurnResponse,
  type CompactTurnRequest,
  type CompactTurnResponse,
  type ReplayLifecycleEventsRequest,
  type ReplayLifecycleEventsResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type SubmitLifecycleApprovalRequest,
  type SubmitUserInputResponseRequest,
} from "./platform/lifecycle-types.js";
export {
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ListArtifactsRequestSchema,
  ListArtifactsResponseSchema,
  ListThreadsRequestSchema,
  ListThreadsResponseSchema,
  ReplayRunEventsRequestSchema,
  ReplayRunEventsResponseSchema,
  SubmitApprovalRequestSchema,
  type CreateRunRequest,
  type CreateThreadRequest,
  type ListArtifactsRequest,
  type ListArtifactsResponse,
  type ListThreadsRequest,
  type ListThreadsResponse,
  type PlatformClient,
  type PlatformClientOperationOptions,
  type PlatformClientTransport,
  type ReplayRunEventsRequest,
  type ReplayRunEventsResponse,
  type SubmitApprovalRequest,
} from "./platform/types.js";
export {
  ProviderClient,
  createProviderClient,
  type ProviderClientTransport,
} from "./providers/client.js";
export {
  deriveSelectionSnapshot,
  getSelectableModelsForProvider,
  resolveConstrainedModelId,
  resolveModelForResolvedProvider,
  resolvePendingVisibleModelId,
  resolveSelectedModelIdForProvider,
  type ProviderSelectionSnapshot,
} from "./providers/selection.js";
export {
  createByokCloudTransport,
  type ProviderCloudTransportOptions,
} from "./providers/cloud-transport.js";
export {
  ProviderClientContractError,
  ProviderClientOperationError,
  ProviderClientTransitionError,
  isProviderErrorEnvelope,
  isRetryableProviderClientErrorCode,
  normalizeProviderClientOperationError,
  parseProviderOperationErrorCode,
  parseProviderErrorEnvelope,
  type ProviderClientOperationErrorCode,
} from "./providers/errors.js";
export {
  PROVIDER_LIFECYCLE_STEPS,
  createInitialProviderLifecycleState,
  isProviderLifecycleStep,
  transitionProviderLifecycle,
  type ProviderLifecycleTransition,
  type ProviderLifecycleState,
  type ProviderLifecycleStep,
} from "./providers/state-machine.js";
export {
  type ProviderModelsQuery,
  BYOKCredentialSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKErrorCodeSchema,
  BYOKErrorEnvelopeSchema,
  BYOKErrorSchema,
  BYOKPreferenceSchema,
  BYOKPreferencesUpdateRequestSchema,
  BYOKResolutionSchema,
  BYOKResolveRequestSchema,
  ProviderRegistryEntrySchema,
  type BYOKCredential,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKError,
  type BYOKErrorCode,
  type BYOKErrorEnvelope,
  type BYOKPreference,
  type BYOKPreferencesUpdateRequest,
  type BYOKResolution,
  type BYOKResolveRequest,
  type ProviderRegistryEntry,
} from "./providers/types.js";
export {
  createTurnWorkflowProjection,
  applyLifecycleEvent,
  replayTurnWorkflowProjection,
  workflowPhaseLabel,
  type TurnWorkflowProjection,
  type WorkflowItem,
  type WorkflowTerminal,
  type WorkflowTerminalState,
  type WorkflowPhase,
  type WorkflowItemKind,
  type WorkflowItemStatus,
  type WorkflowApproval,
  type WorkflowApprovalOption,
  type WorkflowRequest,
  type WorkflowRequestQuestion,
  type WorkflowRequestAnswer,
} from "./workflow/turn-workflow-projection.js";
export {
  groupToolActivity,
  buildSegmentTitle,
  buildActiveWorkflowTrace,
  type ActiveWorkflowTraceProjection,
  type ToolActivitySegment,
} from "./workflow/tool-activity-grouping.js";
export {
  projectThreadSidebar,
  type ProjectThreadSidebarInput,
  type ThreadSidebarDisplayStatus,
  type ThreadSidebarItem,
  type ThreadSidebarPlacement,
  type ThreadSidebarReadModel,
  type ThreadSidebarSourceState,
  type ThreadSidebarThreadInput,
  type ThreadSidebarWorkspaceGroup,
  type ThreadSidebarWorkspaceInput,
} from "./navigation/thread-sidebar-projection.js";
export { workspaceIdFromExternalId } from "@repo/platform-protocol";
export {
  parseReadFileOutput,
  normalizeReadFileContent,
  type ReadFileOutput,
} from "./platform/read-file-output.js";

export * from "./platform/conversation-history.js";

export {
  createLifecycleProjection,
  applyConversationLifecycleEvent,
  replayLifecycleProjection,
  lifecyclePhaseLabel,
  type LifecycleProjection,
  type LifecycleProjectionTerminalState,
  type LifecycleProjectionPhase,
  type LifecycleProjectionItemStatus,
  type LifecycleProjectionItem,
  type LifecycleProjectionApproval,
  type LifecycleProjectionTerminal,
} from "./workflow/conversation-lifecycle-projection.js";
export { mergeLifecycleProjections } from "./workflow/merge-lifecycle-projections.js";

export {
  buildConversationTurns,
  readCanonicalTurnId,
  resolveMessageTimestamp,
  type ConversationMessage,
  type ConversationTurn,
} from "./platform/conversation-turns.js";
export { collectLifecycleTurnDiffFiles } from "./platform/conversation-turn-diff.js";

export type {
  HostedSession,
  HostedSessionWorkspaceContext,
  HostedSessionPullRequestsResponse,
  HostedSessionCreateRequest,
  HostedSessionReadReceipt,
} from "@repo/platform-protocol";

export type {
  HostedWorkspaceSelectRequest,
  HostedWorkspaceRepository,
  HostedWorkspaceRecord,
  HostedWorkspaceSelection,
  HostedWorkspaceListItem,
  HostedWorkspaceListResponse,
} from "@repo/platform-protocol";
