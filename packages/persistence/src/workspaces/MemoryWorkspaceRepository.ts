import type {
  RepositoryRecord,
  SelectWorkspaceInput,
  WorkspaceBootstrapRecord,
  WorkspaceListItem,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSelectionRecord,
} from "./types.js";

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly reposByKey = new Map<string, RepositoryRecord>();
  private readonly workspacesByKey = new Map<string, WorkspaceRecord>();
  private readonly selectionsByUserId = new Map<
    string,
    WorkspaceSelectionRecord
  >();

  async selectWorkspace(
    input: SelectWorkspaceInput,
  ): Promise<WorkspaceBootstrapRecord> {
    const repository = this.upsertRepository(input);
    const workspace = this.upsertWorkspace(input, repository);
    const selection = {
      userId: input.userId,
      selectedWorkspaceId: workspace.id,
      selectedRepoId: repository.id,
      selectedBranch: input.selectedBranch,
      updatedAt: input.now,
    };

    this.selectionsByUserId.set(input.userId, selection);
    return { repository, workspace, selection };
  }

  async findWorkspaceSelection(
    userId: string,
  ): Promise<WorkspaceBootstrapRecord | null> {
    const selection = this.selectionsByUserId.get(userId);
    if (!selection) {
      return null;
    }

    return this.buildBootstrapRecord(selection);
  }

  async listWorkspaces(userId: string): Promise<WorkspaceListItem[]> {
    const selection = this.selectionsByUserId.get(userId);
    return Array.from(this.workspacesByKey.values())
      .filter((workspace) => workspace.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((workspace) => ({
        workspace,
        repository: this.requireRepository(workspace.repoId),
        selected: selection?.selectedWorkspaceId === workspace.id,
      }));
  }

  private upsertRepository(input: SelectWorkspaceInput): RepositoryRecord {
    const key = buildRepoKey(input.repository);
    const existing = this.reposByKey.get(key);
    const repository = {
      id: existing?.id ?? `repo-${this.reposByKey.size + 1}`,
      provider: input.repository.provider,
      owner: input.repository.owner,
      name: input.repository.name,
      fullName: input.repository.fullName,
      repoUrl: input.repository.repoUrl,
      defaultBranch: input.repository.defaultBranch,
      providerRepoId: input.repository.providerRepoId ?? null,
      createdAt: existing?.createdAt ?? input.repository.now,
      updatedAt: input.repository.now,
    };

    this.reposByKey.set(key, repository);
    return repository;
  }

  private upsertWorkspace(
    input: SelectWorkspaceInput,
    repository: RepositoryRecord,
  ): WorkspaceRecord {
    const key = `${input.userId}:${repository.id}`;
    const existing = this.workspacesByKey.get(key);
    const workspace = {
      id: existing?.id ?? `workspace-${this.workspacesByKey.size + 1}`,
      userId: input.userId,
      repoId: repository.id,
      name: input.workspaceName ?? repository.fullName,
      defaultBranch: repository.defaultBranch,
      lastSelectedBranch: input.selectedBranch,
      status: "active" as const,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      lastOpenedAt: input.now,
    };

    this.workspacesByKey.set(key, workspace);
    return workspace;
  }

  private buildBootstrapRecord(
    selection: WorkspaceSelectionRecord,
  ): WorkspaceBootstrapRecord {
    const workspace = this.requireWorkspace(selection.selectedWorkspaceId);
    return {
      selection,
      workspace,
      repository: this.requireRepository(workspace.repoId),
    };
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = Array.from(this.workspacesByKey.values()).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new Error(`Missing workspace: ${workspaceId}`);
    }
    return workspace;
  }

  private requireRepository(repoId: string): RepositoryRecord {
    const repository = Array.from(this.reposByKey.values()).find(
      (candidate) => candidate.id === repoId,
    );
    if (!repository) {
      throw new Error(`Missing repository: ${repoId}`);
    }
    return repository;
  }
}

function buildRepoKey(input: SelectWorkspaceInput["repository"]): string {
  return `${input.provider}:${input.owner}:${input.name}`;
}
