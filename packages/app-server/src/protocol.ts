import { BYOKPreferenceSchema, BYOKPreferencesUpdateRequestSchema, BYOKResolutionSchema, BYOKResolveRequestSchema } from "@repo/shared-types";
import { BYOKCredentialSchema, BYOKCredentialConnectRequestSchema, BYOKCredentialUpdateRequestSchema, BYOKCredentialValidateRequestSchema, BYOKCredentialValidateResponseSchema } from "@repo/shared-types";
import {
  HostedWorkspaceSelectRequestSchema, HostedWorkspaceListResponseSchema, HostedWorkspaceSelectResponseSchema,
  HostedSessionParamsSchema, HostedSessionCreateRequestSchema, HostedSessionRenameRequestSchema,
  HostedSessionWorkspaceContextRequestSchema, HostedSessionWorkspaceContextSchema,
  HostedSessionPullRequestsResponseSchema,
  HostedSessionReadReceiptRequestSchema, HostedSessionReadReceiptSchema,
  HostedSessionsResponseSchema, HostedArchivedSessionsResponseSchema, HostedSessionResponseSchema,
  APP_SERVER_PROTOCOL_VERSION,
  ConversationHistoryRequestSchema,
  ConversationHistoryResponseSchema,
  AppServerErrorSchema,
  AppServerInitializeResponseSchema,
  LocalWorkspaceGrantResponseSchema,
  ProviderIdSchema,
  ThreadIdSchema,
  ThreadSchema,
  RunIdSchema,
  TurnScopeBootstrapSchema,
  TurnScopeBootstrapRequestSchema,
  TurnScopeReadQuerySchema,
  ReplayLifecycleEventsRequestSchema,
  ReplayLifecycleEventsResponseSchema,
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  SubmitLifecycleApprovalRequestSchema,
  CompactTurnRequestSchema,
  CompactTurnResponseSchema,
  LifecycleEventSchema,
  InterruptTurnRequestSchema,
  InterruptTurnResponseSchema,
  EnqueueThreadInputCommandSchema,
  ListThreadInputsCommandSchema,
  RemoveThreadInputCommandSchema,
  ResumeTurnCommandSchema,
  ResumeTurnReceiptSchema,
  StartQueuedThreadInputCommandSchema,
  SteerQueuedThreadInputCommandSchema,
  SteerTurnCommandSchema,
  ThreadInputQueueSnapshotSchema,
  ThreadInputReceiptSchema,
  UpdateThreadInputCommandSchema,
} from "@repo/platform-protocol";
import {
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKProviderSlugSchema,
  NormalizedProviderErrorSchema,
  ProviderRegistryEntrySchema,
} from "@repo/shared-types";
import {
  EditArtifactDiffResponseSchema,
  EditArtifactIdentitySchema,
  PromptArtifactReviewSourceSchema,
} from "@repo/shared-types";
import { z } from "zod";

const GitRequestContextSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).strict();
const GitFileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked"]),
  additions: z.number(),
  deletions: z.number(),
  isStaged: z.boolean(),
}).strict();
const GitCommitIdentitySchema = z.object({
  authorName: z.string(),
  authorEmail: z.string(),
  source: z.enum(["workspace_git_config", "github_profile", "user_input"]),
  verified: z.boolean(),
}).strict();
const GitStatusResponseSchema = z.union([
  z.object({
    files: z.array(GitFileStatusSchema), ahead: z.number(), behind: z.number(),
    branch: z.string(), repoIdentity: z.string().nullable().optional(),
    commitIdentity: GitCommitIdentitySchema.nullable().optional(),
    hasStaged: z.boolean(), hasUnstaged: z.boolean(), gitAvailable: z.literal(true),
  }).strict(),
  z.object({
    files: z.tuple([]), ahead: z.literal(0), behind: z.literal(0), branch: z.literal(""),
    repoIdentity: z.string().nullable().optional(), commitIdentity: z.null().optional(),
    hasStaged: z.literal(false), hasUnstaged: z.literal(false), gitAvailable: z.literal(false),
    recoverableCode: z.literal("NOT_A_GIT_REPOSITORY"),
  }).strict(),
]);
const GitDiffResponseSchema = z.object({
  oldPath: z.string(), newPath: z.string(), hunks: z.array(z.object({
    oldStart: z.number(), oldLines: z.number(), newStart: z.number(), newLines: z.number(),
    lines: z.array(z.object({ type: z.enum(["unchanged", "added", "deleted"]), content: z.string(), oldLineNumber: z.number().optional(), newLineNumber: z.number().optional() }).strict()),
    header: z.string(),
  }).strict()), isBinary: z.boolean(), isNewFile: z.boolean(), isDeleted: z.boolean(),
}).strict();
const GitMutationSuccessSchema = z.object({ success: z.literal(true) }).strict();
const GitBranchResultSchema = z.object({ success: z.literal(true), branch: z.string() }).strict();
const GitPushResultSchema = z.object({ success: z.literal(true), branch: z.string(), remote: z.string() }).strict();
const GitPullRequestResultSchema = z.object({ success: z.literal(true), pullRequest: z.object({
  number: z.number(), title: z.string(), url: z.string(), state: z.enum(["open", "closed"]), head: z.string(), base: z.string(),
}).strict() }).strict();
const GitCommitRequestSchema = z.object({
  message: z.string().min(1), files: z.array(z.string().min(1)).min(1),
  authorName: z.string().optional(), authorEmail: z.string().optional(),
}).strict().superRefine((value, context) => {
  if ((value.authorName === undefined) !== (value.authorEmail === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "authorName and authorEmail must be provided together" });
  }
});

export { APP_SERVER_PROTOCOL_VERSION, AppServerErrorSchema };

export const AppServerProviderErrorSchema = NormalizedProviderErrorSchema.extend({
  statusCode: z.number().int().min(400).max(599),
}).strict();

const EmptyParamsSchema = z.object({}).strict();
const ProviderSelectionSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1).max(256).refine((value) => value.trim() === value),
}).strict();
const ClientSchema = z
  .object({
    id: z.string().min(1).max(120),
    version: z.string().min(1).max(120),
  })
  .strict();
const WorkspaceGrantSourceSchema = z.union([
  z.object({ selectionToken: z.string().min(1).max(512) }).strict(),
  z.object({ path: z.string().min(1).max(4_096) }).strict(),
]);

export const ThreadCreateParamsSchema = z
  .object({ title: z.string().trim().min(1).max(80).optional() })
  .strict();
export const ThreadRenameParamsSchema = z
  .object({ threadId: ThreadIdSchema, title: z.string().trim().min(1).max(80) })
  .strict();

export const HostedTurnScopeReserveParamsSchema = TurnScopeBootstrapRequestSchema.pick({
  runId: true,
  sessionId: true,
  clientMessageId: true,
  revisionOfTurnId: true,
}).extend({ clientMessageId: TurnScopeBootstrapRequestSchema.shape.clientMessageId.unwrap() }).strict();
const HostedTurnScopeReadParamsSchema = TurnScopeReadQuerySchema.strict();
const HostedTurnInterruptParamsSchema = InterruptTurnRequestSchema.extend({
  orchestratorBackend: z.enum(["execution-engine-v1", "cloudflare_agents"]).optional(),
}).strict();
const ArtifactReviewLatestParamsSchema = EditArtifactIdentitySchema.extend({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).strict();
const ArtifactReviewByMessageParamsSchema = EditArtifactIdentitySchema.extend({
  runId: z.string().min(1),
  assistantMessageId: z.string().min(1),
}).strict();
const ArtifactDiffParamsSchema = EditArtifactIdentitySchema.extend({
  artifactId: z.string().uuid(),
  path: z.string().min(1),
}).strict();
const ArtifactReviewLookupResultSchema = z.object({
  source: PromptArtifactReviewSourceSchema.nullable(),
  status: z.union([z.literal(200), z.literal(204)]),
}).strict().refine(
  (result) => (result.status === 200) === (result.source !== null),
  "Artifact review lookup status must match its source",
);
const GitStatusParamsSchema = GitRequestContextSchema;
const GitDiffParamsSchema = GitRequestContextSchema.extend({
  path: z.string().min(1).optional(),
  staged: z.boolean().optional(),
}).strict();
const GitStageParamsSchema = GitRequestContextSchema.extend({
  files: z.array(z.string().min(1)),
  unstage: z.boolean().optional(),
}).strict();
const GitCommitParamsSchema = GitRequestContextSchema.extend({
  payload: GitCommitRequestSchema,
}).strict();
const GitBranchParamsSchema = GitRequestContextSchema.extend({
  payload: z.object({ branch: z.string().min(1) }).strict(),
}).strict();
const GitPushParamsSchema = GitRequestContextSchema.extend({
  payload: z.object({ branch: z.string().min(1), remote: z.string().min(1).optional() }).strict(),
}).strict();
const GitPullRequestParamsSchema = GitRequestContextSchema.extend({
  payload: z.object({
    owner: z.string().min(1), repo: z.string().min(1), title: z.string().min(1),
    body: z.string().optional(), base: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const AppServerMethodSchema = z.enum([
  "initialize",
  "session/history",
  "session/list",
  "session/create",
  "session/rename",
  "session/pin",
  "session/unpin",
  "session/archive",
  "session/unarchive",
  "session/delete",
  "session/archived",
  "session/readReceipt",
  "session/workspaceContext",
  "session/pullRequests",
  "turn/reserve",
  "turn/scope",
  "turn/interrupt",
  "turn/steer",
  "turn/resume",
  "thread/input/enqueue",
  "thread/input/list",
  "thread/input/update",
  "thread/input/remove",
  "thread/input/steer",
  "thread/input/start",
  "turn/lifecycleEvents",
  "turn/diff",
  "turn/approval",
  "turn/compact",
  "artifact/reviewLatest",
  "artifact/reviewByMessage",
  "artifact/diff",
  "git/status",
  "git/diff",
  "git/stage",
  "git/commit",
  "git/branch",
  "git/push",
  "git/pullRequest",

  "workspace/list",
  "workspace/select",
  "workspace/current",
  "workspace/grant",
  "workspace/revoke",
  "thread/list",
  "thread/create",
  "thread/get",
  "thread/rename",
  "thread/archive",
  "thread/unarchive",
  "provider/catalog",
  "provider/models",
  "provider/models/refresh",
  "provider/preferences/read",
  "provider/preferences/update",
  "provider/resolve",

  "provider/credentials/list",
  "provider/credentials/connect",
  "provider/credentials/update",
  "provider/credentials/disconnect",
  "provider/credentials/validate",

  "provider/current",
  "provider/select",
  "provider/clear",
]);

const AppServerRequestShape = {
  protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
};

export const AppServerRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/list"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/select"), params: HostedWorkspaceSelectRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/list"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/create"), params: HostedSessionCreateRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/rename"), params: HostedSessionRenameRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/pin"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/unpin"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/archive"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/unarchive"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/delete"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/archived"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/readReceipt"), params: HostedSessionReadReceiptRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/workspaceContext"), params: HostedSessionWorkspaceContextRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("session/pullRequests"), params: HostedSessionParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/reserve"), params: HostedTurnScopeReserveParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/scope"), params: HostedTurnScopeReadParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/interrupt"), params: HostedTurnInterruptParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/steer"), params: SteerTurnCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/resume"), params: ResumeTurnCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/enqueue"), params: EnqueueThreadInputCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/list"), params: ListThreadInputsCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/update"), params: UpdateThreadInputCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/remove"), params: RemoveThreadInputCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/steer"), params: SteerQueuedThreadInputCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/input/start"), params: StartQueuedThreadInputCommandSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/lifecycleEvents"), params: ReplayLifecycleEventsRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/diff"), params: GetTurnDiffRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/approval"), params: SubmitLifecycleApprovalRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("turn/compact"), params: CompactTurnRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("artifact/reviewLatest"), params: ArtifactReviewLatestParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("artifact/reviewByMessage"), params: ArtifactReviewByMessageParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("artifact/diff"), params: ArtifactDiffParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/status"), params: GitStatusParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/diff"), params: GitDiffParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/stage"), params: GitStageParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/commit"), params: GitCommitParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/branch"), params: GitBranchParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/push"), params: GitPushParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("git/pullRequest"), params: GitPullRequestParamsSchema }).strict(),

  z.object({ ...AppServerRequestShape, method: z.literal("session/history"), params: ConversationHistoryRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("initialize"), params: z.object({ client: ClientSchema, requestedCapabilities: z.array(z.string().min(1).max(120)).max(100) }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/current"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/grant"), params: WorkspaceGrantSourceSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/revoke"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/list"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/create"), params: ThreadCreateParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/get"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/rename"), params: ThreadRenameParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/archive"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/unarchive"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/catalog"), params: z.object({ runId: RunIdSchema.optional() }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/models"), params: z.object({ providerId: ProviderIdSchema, runId: RunIdSchema.optional(), query: BYOKDiscoveredProviderModelsQuerySchema.strict().optional() }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/models/refresh"), params: z.object({ providerId: BYOKProviderSlugSchema, runId: RunIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/preferences/read"), params: z.object({ runId: RunIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/preferences/update"), params: z.object({ runId: RunIdSchema, request: BYOKPreferencesUpdateRequestSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/resolve"), params: z.object({ runId: RunIdSchema, request: BYOKResolveRequestSchema.strict() }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/credentials/list"), params: z.object({ runId: RunIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/credentials/connect"), params: z.object({ runId: RunIdSchema, request: BYOKCredentialConnectRequestSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/credentials/update"), params: z.object({ runId: RunIdSchema, credentialId: z.string().min(1), request: BYOKCredentialUpdateRequestSchema.strict() }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/credentials/disconnect"), params: z.object({ runId: RunIdSchema, credentialId: z.string().min(1) }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/credentials/validate"), params: z.object({ runId: RunIdSchema, credentialId: z.string().min(1), request: BYOKCredentialValidateRequestSchema.strict() }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/current"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/select"), params: ProviderSelectionSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/clear"), params: EmptyParamsSchema }).strict(),
]);
export type AppServerRequest = z.infer<typeof AppServerRequestSchema>;
export type AppServerMethod = z.infer<typeof AppServerMethodSchema>;

export const AppServerResultSchemas = {
  "workspace/list": HostedWorkspaceListResponseSchema,
  "workspace/select": HostedWorkspaceSelectResponseSchema,
  "session/list": HostedSessionsResponseSchema,
  "session/create": HostedSessionResponseSchema,
  "session/rename": HostedSessionResponseSchema,
  "session/pin": HostedSessionResponseSchema,
  "session/unpin": HostedSessionResponseSchema,
  "session/archive": HostedSessionResponseSchema,
  "session/unarchive": HostedSessionResponseSchema,
  "session/delete": z.object({ deleted: z.literal(true) }).strict(),
  "session/archived": HostedArchivedSessionsResponseSchema,
  "session/readReceipt": HostedSessionReadReceiptSchema,
  "session/workspaceContext": HostedSessionWorkspaceContextSchema,
  "session/pullRequests": HostedSessionPullRequestsResponseSchema,
  "turn/reserve": TurnScopeBootstrapSchema,
  "turn/scope": TurnScopeBootstrapSchema,
  "turn/interrupt": InterruptTurnResponseSchema,
  "turn/steer": ThreadInputReceiptSchema,
  "turn/resume": ResumeTurnReceiptSchema,
  "thread/input/enqueue": ThreadInputReceiptSchema,
  "thread/input/list": ThreadInputQueueSnapshotSchema,
  "thread/input/update": ThreadInputReceiptSchema,
  "thread/input/remove": ThreadInputReceiptSchema,
  "thread/input/steer": ThreadInputReceiptSchema,
  "thread/input/start": ThreadInputReceiptSchema,
  "turn/lifecycleEvents": ReplayLifecycleEventsResponseSchema,
  "turn/diff": GetTurnDiffResponseSchema,
  "turn/approval": LifecycleEventSchema,
  "turn/compact": CompactTurnResponseSchema,
  "artifact/reviewLatest": ArtifactReviewLookupResultSchema,
  "artifact/reviewByMessage": ArtifactReviewLookupResultSchema,
  "artifact/diff": EditArtifactDiffResponseSchema,
  "git/status": GitStatusResponseSchema,
  "git/diff": GitDiffResponseSchema,
  "git/stage": GitMutationSuccessSchema,
  "git/commit": GitMutationSuccessSchema,
  "git/branch": GitBranchResultSchema,
  "git/push": GitPushResultSchema,
  "git/pullRequest": GitPullRequestResultSchema,

  "session/history": ConversationHistoryResponseSchema,
  initialize: AppServerInitializeResponseSchema,
  "workspace/current": LocalWorkspaceGrantResponseSchema,
  "workspace/grant": LocalWorkspaceGrantResponseSchema,
  "workspace/revoke": z.object({ revoked: z.literal(true) }).strict(),
  "thread/list": z.object({ threads: z.array(ThreadSchema) }).strict(),
  "thread/create": z.object({ thread: ThreadSchema }).strict(),
  "thread/get": z.object({ thread: ThreadSchema }).strict(),
  "thread/rename": z.object({ thread: ThreadSchema }).strict(),
  "thread/archive": z.object({ thread: ThreadSchema }).strict(),
  "thread/unarchive": z.object({ thread: ThreadSchema }).strict(),
  "provider/catalog": z.object({ providers: ProviderRegistryEntrySchema.array() }).strict(),
  "provider/models": BYOKDiscoveredProviderModelsResponseSchema,
  "provider/models/refresh": BYOKDiscoveredProviderModelsRefreshResponseSchema,
  "provider/preferences/read": BYOKPreferenceSchema,
  "provider/preferences/update": BYOKPreferenceSchema,
  "provider/resolve": BYOKResolutionSchema,

  "provider/credentials/list": BYOKCredentialSchema.array(),
  "provider/credentials/connect": BYOKCredentialSchema,
  "provider/credentials/update": BYOKCredentialSchema,
  "provider/credentials/disconnect": z.object({ disconnected: z.literal(true) }).strict(),
  "provider/credentials/validate": BYOKCredentialValidateResponseSchema,

  "provider/current": z.object({ selection: ProviderSelectionSchema.nullable() }).strict(),
  "provider/select": z.object({ selection: ProviderSelectionSchema }).strict(),
  "provider/clear": z.object({ selection: z.null() }).strict(),
} as const;

export const AppServerSuccessResponseSchema = z.discriminatedUnion("method", [
  success("workspace/list", AppServerResultSchemas["workspace/list"]),
  success("workspace/select", AppServerResultSchemas["workspace/select"]),
  success("session/list", AppServerResultSchemas["session/list"]),
  success("session/create", AppServerResultSchemas["session/create"]),
  success("session/rename", AppServerResultSchemas["session/rename"]),
  success("session/pin", AppServerResultSchemas["session/pin"]),
  success("session/unpin", AppServerResultSchemas["session/unpin"]),
  success("session/archive", AppServerResultSchemas["session/archive"]),
  success("session/unarchive", AppServerResultSchemas["session/unarchive"]),
  success("session/delete", AppServerResultSchemas["session/delete"]),
  success("session/archived", AppServerResultSchemas["session/archived"]),
  success("session/readReceipt", AppServerResultSchemas["session/readReceipt"]),
  success("session/workspaceContext", AppServerResultSchemas["session/workspaceContext"]),
  success("session/pullRequests", AppServerResultSchemas["session/pullRequests"]),
  success("turn/reserve", AppServerResultSchemas["turn/reserve"]),
  success("turn/scope", AppServerResultSchemas["turn/scope"]),
  success("turn/interrupt", AppServerResultSchemas["turn/interrupt"]),
  success("turn/steer", AppServerResultSchemas["turn/steer"]),
  success("turn/resume", AppServerResultSchemas["turn/resume"]),
  success("thread/input/enqueue", AppServerResultSchemas["thread/input/enqueue"]),
  success("thread/input/list", AppServerResultSchemas["thread/input/list"]),
  success("thread/input/update", AppServerResultSchemas["thread/input/update"]),
  success("thread/input/remove", AppServerResultSchemas["thread/input/remove"]),
  success("thread/input/steer", AppServerResultSchemas["thread/input/steer"]),
  success("thread/input/start", AppServerResultSchemas["thread/input/start"]),
  success("turn/lifecycleEvents", AppServerResultSchemas["turn/lifecycleEvents"]),
  success("turn/diff", AppServerResultSchemas["turn/diff"]),
  success("turn/approval", AppServerResultSchemas["turn/approval"]),
  success("turn/compact", AppServerResultSchemas["turn/compact"]),
  success("artifact/reviewLatest", AppServerResultSchemas["artifact/reviewLatest"]),
  success("artifact/reviewByMessage", AppServerResultSchemas["artifact/reviewByMessage"]),
  success("artifact/diff", AppServerResultSchemas["artifact/diff"]),
  success("git/status", AppServerResultSchemas["git/status"]),
  success("git/diff", AppServerResultSchemas["git/diff"]),
  success("git/stage", AppServerResultSchemas["git/stage"]),
  success("git/commit", AppServerResultSchemas["git/commit"]),
  success("git/branch", AppServerResultSchemas["git/branch"]),
  success("git/push", AppServerResultSchemas["git/push"]),
  success("git/pullRequest", AppServerResultSchemas["git/pullRequest"]),

  success("session/history", AppServerResultSchemas["session/history"]),
  success("initialize", AppServerResultSchemas.initialize),
  success("workspace/current", AppServerResultSchemas["workspace/current"]),
  success("workspace/grant", AppServerResultSchemas["workspace/grant"]),
  success("workspace/revoke", AppServerResultSchemas["workspace/revoke"]),
  success("thread/list", AppServerResultSchemas["thread/list"]),
  success("thread/create", AppServerResultSchemas["thread/create"]),
  success("thread/get", AppServerResultSchemas["thread/get"]),
  success("thread/rename", AppServerResultSchemas["thread/rename"]),
  success("thread/archive", AppServerResultSchemas["thread/archive"]),
  success("thread/unarchive", AppServerResultSchemas["thread/unarchive"]),
  success("provider/catalog", AppServerResultSchemas["provider/catalog"]),
  success("provider/models", AppServerResultSchemas["provider/models"]),
  success("provider/models/refresh", AppServerResultSchemas["provider/models/refresh"]),
  success("provider/preferences/read", AppServerResultSchemas["provider/preferences/read"]),
  success("provider/preferences/update", AppServerResultSchemas["provider/preferences/update"]),
  success("provider/resolve", AppServerResultSchemas["provider/resolve"]),

  success("provider/credentials/list", AppServerResultSchemas["provider/credentials/list"]),
  success("provider/credentials/connect", AppServerResultSchemas["provider/credentials/connect"]),
  success("provider/credentials/update", AppServerResultSchemas["provider/credentials/update"]),
  success("provider/credentials/disconnect", AppServerResultSchemas["provider/credentials/disconnect"]),
  success("provider/credentials/validate", AppServerResultSchemas["provider/credentials/validate"]),

  success("provider/current", AppServerResultSchemas["provider/current"]),
  success("provider/select", AppServerResultSchemas["provider/select"]),
  success("provider/clear", AppServerResultSchemas["provider/clear"]),
]);

export const AppServerFailureResponseSchema = z
  .object({
    protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
    method: AppServerMethodSchema,
    ok: z.literal(false),
    error: z.union([AppServerErrorSchema, AppServerProviderErrorSchema]),
  })
  .strict();

export const AppServerResponseSchema = z.union([
  AppServerSuccessResponseSchema,
  AppServerFailureResponseSchema,
]);
export type AppServerResponse = z.infer<typeof AppServerResponseSchema>;
export type AppServerSuccessResponse = z.infer<
  typeof AppServerSuccessResponseSchema
>;
export type AppServerFailureResponse = z.infer<
  typeof AppServerFailureResponseSchema
>;

function success<
  const Method extends AppServerMethod,
  Schema extends z.ZodTypeAny,
>(
  method: Method,
  result: Schema,
) {
  return z
    .object({
      protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
      method: z.literal(method),
      ok: z.literal(true),
      result,
    })
    .strict();
}
