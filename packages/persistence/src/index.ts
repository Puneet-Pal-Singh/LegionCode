export type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "./sql.js";
export {
  PgSqlClient,
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
export type {
  EncryptedOAuthToken,
  GitHubIdentitySessionInput,
  IdentitySessionRecord,
  IdentitySessionRepository,
} from "./identity/types.js";
export type {
  RepositoryRecord,
  SelectWorkspaceInput,
  WorkspaceBootstrapRecord,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSelectionRecord,
  WorkspaceStatus,
} from "./workspaces/types.js";
export { WORKSPACE_STATUSES } from "./workspaces/types.js";
export type {
  RuntimeEventInboxAcceptResult,
  RuntimeEventInboxEntry,
  RuntimeEventInboxRepository,
  RuntimeEventInboxStatus,
} from "./runtime-events/types.js";
export {
  accounts,
  authSessions,
  oauthTokens,
  repos,
  runtimeEventInbox,
  users,
  workspaces,
  workspaceSelections,
} from "./schema/index.js";
