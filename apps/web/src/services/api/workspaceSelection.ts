import type {
  HostedWorkspaceSelection, HostedWorkspaceListItem,
  HostedWorkspaceListResponse, HostedWorkspaceRepository,
} from "@legioncode/sdk";
import type { Repository } from "../GitHubService";
import { createHostedAppServerClient } from "./appServerClient";

export type WorkspaceSelection = HostedWorkspaceSelection;
export type WorkspaceListItem = HostedWorkspaceListItem;
export type WorkspaceListResponse = HostedWorkspaceListResponse;
export type WorkspaceRepositoryRecord = HostedWorkspaceRepository;

// Preserve the lifetime/body contract of the replaced hosted workspace fetches.
function client() {
  return createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null });
}

export function listWorkspaces(): Promise<WorkspaceListResponse> {
  return client().listHostedWorkspaces();
}

export function selectWorkspace(repository: Repository, selectedBranch: string): Promise<WorkspaceSelection> {
  return client().selectHostedWorkspace({
    repository: { owner: repository.owner.login, name: repository.name }, selectedBranch,
  });
}
