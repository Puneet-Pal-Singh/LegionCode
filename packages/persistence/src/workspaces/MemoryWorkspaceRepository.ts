import { RepositoryIdentityConflictError } from "./types.js";
import type {
  RepositoryRecord,
  UpdateWorkspaceConfigurationInput,
  WorkspaceConfigurationRecord,
  WorkspaceConfigurationUpdateResult,
  SelectWorkspaceInput,
  WorkspaceBootstrapRecord,
  WorkspaceListItem,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSelectionRecord,
} from "./types.js";

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly reposByKey = new Map<string, RepositoryRecord>();
  private readonly workspacesByKey = new Map<
    string,
    WorkspaceRecord & { configurationVersion: number }
  >();
  private readonly selectionsByUserId = new Map<
    string,
    WorkspaceSelectionRecord
  >();

  async findWorkspaceConfiguration(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceConfigurationRecord | null> {
    const stored = Array.from(this.workspacesByKey.values()).find(
      (workspace) =>
        workspace.id === workspaceId &&
        workspace.userId === userId &&
        workspace.status === "active",
    );
    if (!stored) return null;
    const { configurationVersion: version, ...workspace } = stored;
    return {
      workspace: { ...workspace },
      repository: { ...this.requireRepository(workspace.repoId) },
      version,
    };
  }

  async updateWorkspaceConfiguration(
    request: UpdateWorkspaceConfigurationInput,
  ): Promise<WorkspaceConfigurationUpdateResult> {
    const input = {
      ...request,
      patch: { ...request.patch },
      expectedRepository: { ...request.expectedRepository },
    };
    // No awaits between reading the revision and updating both records.
    const stored = Array.from(this.workspacesByKey.values()).find(
      (workspace) =>
        workspace.id === input.workspaceId &&
        workspace.userId === input.userId &&
        workspace.status === "active",
    );
    if (!stored) return { status: "not_found" };
    const repository = this.requireRepository(stored.repoId);
    if (
      !/^[1-9][0-9]*$/u.test(input.expectedRepository.providerRepoId) ||
      stored.repoId !== input.expectedRepository.id ||
      repository.providerRepoId !== input.expectedRepository.providerRepoId
    ) {
      throw new RepositoryIdentityConflictError();
    }
    if (stored.configurationVersion !== input.expectedVersion)
      return { status: "conflict" };
    const name = input.patch.name ?? stored.name;
    const branch = input.patch.selectedBranch ?? stored.lastSelectedBranch;
    if (name !== stored.name || branch !== stored.lastSelectedBranch) {
      Object.assign(stored, {
        name,
        lastSelectedBranch: branch,
        configurationVersion: stored.configurationVersion + 1,
        updatedAt: input.now,
      });
      const selection = this.selectionsByUserId.get(input.userId);
      if (
        selection?.selectedWorkspaceId === stored.id &&
        selection.selectedRepoId === stored.repoId
      ) {
        this.selectionsByUserId.set(input.userId, {
          ...selection,
          selectedBranch: branch,
          updatedAt: input.now,
        });
      }
    }
    const { configurationVersion: version, ...workspace } = stored;
    return {
      status: "updated",
      configuration: {
        workspace: { ...workspace },
        repository: { ...this.requireRepository(stored.repoId) },
        version,
      },
    };
  }

  async selectWorkspace(
    request: SelectWorkspaceInput,
  ): Promise<WorkspaceBootstrapRecord> {
    const input = { ...request, repository: { ...request.repository } };
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
    return {
      repository: { ...repository },
      workspace: { ...workspace },
      selection: { ...selection },
    };
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
        workspace: publicWorkspace(workspace),
        repository: { ...this.requireRepository(workspace.repoId) },
        selected: selection?.selectedWorkspaceId === workspace.id,
      }));
  }

  private upsertRepository(input: SelectWorkspaceInput): RepositoryRecord {
    const key = buildRepoKey(input.repository);
    const existing = this.reposByKey.get(key);
    // Existing namespace identity (including legacy null) cannot be rebound.
    if (
      existing &&
      existing.providerRepoId !== (input.repository.providerRepoId ?? null)
    ) {
      throw new RepositoryIdentityConflictError();
    }
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
      name: existing?.name ?? input.workspaceName ?? repository.fullName,
      defaultBranch: repository.defaultBranch,
      lastSelectedBranch: input.selectedBranch,
      status: "active" as const,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      lastOpenedAt: input.now,
      configurationVersion: existing
        ? existing.configurationVersion +
          (existing.lastSelectedBranch !== input.selectedBranch ||
          existing.defaultBranch !== repository.defaultBranch ||
          existing.status !== "active"
            ? 1
            : 0)
        : 1,
    };

    this.workspacesByKey.set(key, workspace);
    return publicWorkspace(workspace);
  }

  private buildBootstrapRecord(
    selection: WorkspaceSelectionRecord,
  ): WorkspaceBootstrapRecord {
    const workspace = this.requireWorkspace(selection.selectedWorkspaceId);
    return {
      selection: { ...selection },
      workspace,
      repository: { ...this.requireRepository(workspace.repoId) },
    };
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = Array.from(this.workspacesByKey.values()).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new Error(`Missing workspace: ${workspaceId}`);
    }
    return publicWorkspace(workspace);
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

function publicWorkspace(
  stored: WorkspaceRecord & { configurationVersion: number },
): WorkspaceRecord {
  const { configurationVersion: _version, ...workspace } = stored;
  return workspace;
}
