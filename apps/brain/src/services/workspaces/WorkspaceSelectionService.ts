import type {
  RepositoryRecord,
  UpdateWorkspaceConfigurationInput,
  WorkspaceConfigurationRecord,
  WorkspaceBootstrapRecord,
  WorkspaceListItem,
  WorkspaceRepository,
} from "@repo/persistence";
import type { Repository } from "@legioncode/github-bridge";

export interface SelectGitHubWorkspaceInput {
  userId: string;
  repository: Repository;
  selectedBranch: string;
  now?: string;
}

export interface WorkspaceSelectionView {
  workspaceId: string;
  repoId: string;
  selectedBranch: string;
  repository: RepositoryRecord;
  workspaceName: string;
  updatedAt: string;
}

export interface WorkspaceListView {
  workspaces: WorkspaceListItem[];
  selection: WorkspaceSelectionView | null;
}

export class WorkspaceSelectionService {
  constructor(private readonly repository: WorkspaceRepository) {}

  async getConfiguration(userId: string, workspaceId: string) {
    return this.repository.findWorkspaceConfiguration(userId, workspaceId);
  }

  async updateConfiguration(input: UpdateWorkspaceConfigurationInput) {
    return this.repository.updateWorkspaceConfiguration(input);
  }

  async selectGitHubWorkspace(
    input: SelectGitHubWorkspaceInput,
  ): Promise<WorkspaceSelectionView> {
    const now = input.now ?? new Date().toISOString();
    const selected = await this.repository.selectWorkspace({
      userId: input.userId,
      selectedBranch: input.selectedBranch,
      now,
      workspaceName: input.repository.full_name,
      repository: {
        provider: "github",
        owner: input.repository.owner.login,
        name: input.repository.name,
        fullName: input.repository.full_name,
        repoUrl: input.repository.html_url,
        defaultBranch: input.repository.default_branch,
        providerRepoId: String(input.repository.id),
        now,
      },
    });

    return toSelectionView(selected);
  }

  async getWorkspaceList(userId: string): Promise<WorkspaceListView> {
    const [workspaces, selected] = await Promise.all([
      this.repository.listWorkspaces(userId),
      this.repository.findWorkspaceSelection(userId),
    ]);

    return {
      workspaces,
      selection: selected ? toSelectionView(selected) : null,
    };
  }
}

export function toSelectionView(
  record: WorkspaceBootstrapRecord,
): WorkspaceSelectionView {
  return {
    workspaceId: record.workspace.id,
    repoId: record.repository.id,
    selectedBranch: record.selection.selectedBranch,
    repository: record.repository,
    workspaceName: record.workspace.name,
    updatedAt: record.selection.updatedAt,
  };
}

export function toConfigurationView(record: WorkspaceConfigurationRecord) {
  return {
    workspaceId: record.workspace.id,
    repository: record.repository,
    version: record.version,
    name: record.workspace.name,
    selectedBranch: record.workspace.lastSelectedBranch,
  };
}
