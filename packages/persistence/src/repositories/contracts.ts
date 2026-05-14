export type PersistenceDomain =
  | "identity"
  | "workspace"
  | "transcript"
  | "run"
  | "artifact"
  | "provider"
  | "context"
  | "usage";

export interface RepositoryContract<Domain extends PersistenceDomain> {
  readonly domain: Domain;
}

export type UserRepository = RepositoryContract<"identity">;
export type AccountRepository = RepositoryContract<"identity">;
export type AuthSessionRepository = RepositoryContract<"identity">;
export type RepoRepository = RepositoryContract<"workspace">;
export type WorkspaceRepository = RepositoryContract<"workspace">;
export type TaskRepository = RepositoryContract<"transcript">;
export type SessionRepository = RepositoryContract<"transcript">;
export type MessageRepository = RepositoryContract<"transcript">;
export type RunRepository = RepositoryContract<"run">;
export type ArtifactRepository = RepositoryContract<"artifact">;
export type ProviderRepository = RepositoryContract<"provider">;
export type ContextRepository = RepositoryContract<"context">;
export type UsageRepository = RepositoryContract<"usage">;
