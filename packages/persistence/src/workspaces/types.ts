export const WORKSPACE_STATUSES = ["active", "archived"] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface RepositoryRecord {
  id: string;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  repoUrl: string;
  defaultBranch: string;
  providerRepoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  userId: string;
  repoId: string;
  name: string;
  defaultBranch: string;
  lastSelectedBranch: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface WorkspaceSelectionRecord {
  userId: string;
  selectedWorkspaceId: string;
  selectedRepoId: string;
  selectedBranch: string;
  updatedAt: string;
}

export interface UpsertRepositoryInput {
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  repoUrl: string;
  defaultBranch: string;
  providerRepoId?: string | null;
  now: string;
}

export interface SelectWorkspaceInput {
  userId: string;
  repository: UpsertRepositoryInput;
  workspaceName?: string;
  selectedBranch: string;
  now: string;
}

export interface WorkspaceBootstrapRecord {
  repository: RepositoryRecord;
  workspace: WorkspaceRecord;
  selection: WorkspaceSelectionRecord;
}

export interface WorkspaceRepository {
  selectWorkspace(input: SelectWorkspaceInput): Promise<WorkspaceBootstrapRecord>;
  findWorkspaceSelection(
    userId: string,
  ): Promise<WorkspaceBootstrapRecord | null>;
  listWorkspaces(userId: string): Promise<WorkspaceBootstrapRecord[]>;
}

export function buildWorkspaceStatusSqlList(): string {
  return WORKSPACE_STATUSES.map((status) => `'${status}'`).join(", ");
}
