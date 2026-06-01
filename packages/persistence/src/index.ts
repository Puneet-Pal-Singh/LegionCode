export type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "./sql.js";
export {
  PgSqlClient,
  createPostgresSqlClient,
  withPostgresSqlClient,
  type PgConnection,
} from "./postgres/PgSqlClient.js";
export {
  withDrizzleDatabase,
  type PersistenceDatabase,
} from "./postgres/DrizzleDatabase.js";
export {
  readDatabaseMigrationsMode,
  readWorkerDatabaseConfig,
  DatabaseConfigurationError,
  DATABASE_MIGRATIONS_MODES,
  type DatabaseMigrationsMode,
  type HyperdriveConnectionBinding,
  type WorkerDatabaseConfig,
  type WorkerDatabaseEnv,
} from "./config/database.js";

export { identitySessionBootstrapMigration } from "./migrations/0002-identity-session-bootstrap.js";
export { workspaceBootstrapMigration } from "./migrations/0003-workspace-bootstrap.js";
export { providerStateBootstrapMigration } from "./migrations/0004-provider-state-bootstrap.js";
export { transcriptBootstrapMigration } from "./migrations/0005-transcript-bootstrap.js";
export { runBootstrapMigration } from "./migrations/0006-run-bootstrap.js";
export { contextMemoryPermissionsBootstrapMigration } from "./migrations/0007-context-memory-permissions-bootstrap.js";
export { artifactMetadataBootstrapMigration } from "./migrations/0008-artifact-metadata-bootstrap.js";
export { artifactRestoreLookupIndexMigration } from "./migrations/0009-artifact-restore-lookup-index.js";
export { sessionsActiveRunForeignKeyMigration } from "./migrations/0010-sessions-active-run-fk.js";
export { providerUserModelCacheTextKeyMigration } from "./migrations/0011-provider-user-model-cache-text-key.js";
export { sessionOrganizationMetadataMigration } from "./migrations/0012-session-organization-metadata.js";
export { artifactReviewMetadataMigration } from "./migrations/0013-artifact-review-metadata.js";
export { pausedRunAndSessionStatusMigration } from "./migrations/0014-paused-run-and-session-status.js";
export {
  runtimeEventInboxMigration,
  persistenceMigrations,
} from "./migrations/0001-runtime-event-inbox.js";
export { PostgresMigrationLedger } from "./migrations/PostgresMigrationLedger.js";
export { PostgresMigrationRunner } from "./migrations/PostgresMigrationRunner.js";
export type {
  MigrationLedger,
  MigrationRunResult,
  MigrationRunner,
  SqlMigration,
} from "./migrations/types.js";

export { PostgresRuntimeEventInboxRepository } from "./runtime-events/PostgresRuntimeEventInboxRepository.js";
export { MemoryRuntimeEventInboxRepository } from "./runtime-events/MemoryRuntimeEventInboxRepository.js";
export { MemoryIdentitySessionRepository } from "./identity/MemoryIdentitySessionRepository.js";
export { PostgresIdentitySessionRepository } from "./identity/PostgresIdentitySessionRepository.js";
export { MemoryWorkspaceRepository } from "./workspaces/MemoryWorkspaceRepository.js";
export { PostgresWorkspaceRepository } from "./workspaces/PostgresWorkspaceRepository.js";
export { MemoryTranscriptRepository } from "./sessions/MemoryTranscriptRepository.js";
export { PostgresTranscriptRepository } from "./sessions/PostgresTranscriptRepository.js";
export { MemoryRunRepository } from "./runs/MemoryRunRepository.js";
export { PostgresRunRepository } from "./runs/PostgresRunRepository.js";
export { InMemoryEventRepository } from "./memory/InMemoryEventRepository.js";
export { PostgresMemoryEventRepository } from "./memory/PostgresMemoryEventRepository.js";
export { MemoryContextRepository } from "./context/MemoryContextRepository.js";
export { PostgresContextRepository } from "./context/PostgresContextRepository.js";
export { MemoryPermissionRepository } from "./permissions/MemoryPermissionRepository.js";
export { PostgresPermissionRepository } from "./permissions/PostgresPermissionRepository.js";
export { MemoryArtifactRepository } from "./artifacts/MemoryArtifactRepository.js";
export { PostgresArtifactRepository } from "./artifacts/PostgresArtifactRepository.js";
export {
  PostgresCredentialStore,
  PostgresPreferenceStore,
  PostgresProviderAuditLog,
  PostgresProviderModelCacheStore,
  PostgresProviderRegistryCacheStore,
  PostgresProviderQuotaStore,
  PostgresUserProviderModelCacheStore,
  MemoryCredentialStore,
  MemoryPreferenceStore,
  MemoryProviderAuditLog,
  MemoryProviderModelCacheStore,
  MemoryProviderQuotaStore,
  parseJsonColumn,
  stringifyJsonColumn,
} from "./providers/index.js";
export type {
  EncryptedOAuthToken,
  GitHubIdentitySessionInput,
  IdentitySessionRecord,
  IdentitySessionRepository,
} from "./identity/types.js";
export type {
  CredentialStore,
  ProviderAuditEvent,
  ProviderAuditLog,
  ProviderAuditEventType,
  ProviderAuditStatus,
  ProviderCredentialStatus,
  ProviderCredentialRecord,
  ProviderModelCacheRecord,
  ProviderModelCacheStore,
  PreferenceStore,
  ProviderQuotaStore,
  SetCredentialInput,
  UserScopedCacheKey,
} from "./providers/types.js";
export {
  PROVIDER_AUDIT_EVENT_TYPES,
  PROVIDER_AUDIT_STATUSES,
  PROVIDER_CREDENTIAL_STATUSES,
  buildProviderAuditEventTypeSqlList,
  buildProviderAuditStatusSqlList,
  buildProviderCredentialStatusSqlList,
} from "./providers/types.js";
export type {
  RepositoryRecord,
  SelectWorkspaceInput,
  WorkspaceBootstrapRecord,
  WorkspaceListItem,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSelectionRecord,
  WorkspaceStatus,
} from "./workspaces/types.js";
export { WORKSPACE_STATUSES } from "./workspaces/types.js";
export type {
  AppendExistingTranscriptMessageInput,
  AppendTranscriptMessageInput,
  EnsureTranscriptSessionInput,
  ListSessionsResult,
  ListTranscriptInput,
  ListTranscriptResult,
  SessionRecord,
  SessionStatus,
  TaskRecord,
  TaskStatus,
  TranscriptMessagePartRecord,
  TranscriptMessagePartType,
  TranscriptMessageRecord,
  TranscriptMessageRole,
  TranscriptRepository,
} from "./sessions/types.js";
export {
  MESSAGE_PART_TYPES,
  MESSAGE_ROLES,
  SESSION_STATUSES,
  TASK_STATUSES,
  buildChatTitleSourceSqlList,
  buildMessagePartTypeSqlList,
  buildMessageRoleSqlList,
  buildSessionStatusSqlList,
  buildTaskStatusSqlList,
} from "./sessions/types.js";
export type {
  RuntimeEventInboxAcceptResult,
  RuntimeEventInboxEntry,
  RuntimeEventInboxRepository,
  RuntimeEventInboxStatus,
} from "./runtime-events/types.js";

export type {
  RunRecord,
  RunStatus,
  RunStepRecord,
  RunStepStatus,
  RunEventRecord,
  EnsureRunInput,
  UpdateRunStatusInput,
  AppendRunEventInput,
  UpsertRunStepInput,
  RunRepository,
} from "./runs/types.js";

export {
  RUN_STATUSES,
  RUN_STEP_STATUSES,
  buildRunStatusSqlList,
  buildRunStepStatusSqlList,
} from "./runs/types.js";

export type {
  MemoryEventRecord,
  MemoryEventRepository,
  AppendMemoryEventInput,
  AppendMemoryEventResult,
} from "./memory/types.js";

export type {
  ContextRepository,
  ContextSnapshotRecord,
  ContextSnapshotSourceRecord,
  CreateContextSnapshotInput,
  AddContextSourceInput,
} from "./context/types.js";

export type {
  PermissionRepository,
  PermissionRequestRecord,
  PermissionDecisionRecord,
  CreatePermissionRequestInput,
  CreatePermissionDecisionInput,
  PermissionRequestStatus,
  PermissionDecisionKind,
} from "./permissions/types.js";
export {
  PERMISSION_REQUEST_STATUSES,
  PERMISSION_DECISION_KINDS,
} from "./permissions/types.js";

export type {
  AppendArtifactEventInput,
  ArtifactRepository,
  UpdateArtifactStatusInput,
} from "./artifacts/types.js";

export {
  accounts,
  authSessions,
  oauthTokens,
  repos,
  providerCredentials,
  providerPreferences,
  providerAuditEvents,
  providerAxisQuota,
  providerRegistryCache,
  providerUserModelCache,
  runtimeEventInbox,
  messageParts,
  messages,
  sessions,
  tasks,
  users,
  workspaces,
  workspaceSelections,
  runs,
  runSteps,
  runEvents,
  memoryEvents,
  contextSnapshots,
  contextSnapshotSources,
  permissionRequests,
  permissionDecisions,
  artifacts,
  artifactEvents,
  artifactChangedFiles,
} from "./schema/index.js";
