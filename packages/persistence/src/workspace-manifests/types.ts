import {
  WorkspaceManifestSchema,
  WorkspaceManifestStateSchema,
  type RunId,
  type WorkspaceManifest,
  type WorkspaceManifestId,
  type WorkspaceManifestState,
} from "@repo/platform-protocol";

export const WORKSPACE_MANIFEST_VERSION = 1;

export interface SaveWorkspaceManifestInput {
  manifest: WorkspaceManifest;
}

export interface TransitionWorkspaceManifestInput {
  manifestId: WorkspaceManifestId;
  nextState: WorkspaceManifestState;
  headCommitSha: WorkspaceManifest["headCommitSha"];
  lastError: string | null;
  updatedAt: string;
}

export interface WorkspaceManifestRepository {
  saveManifest(
    input: SaveWorkspaceManifestInput,
  ): Promise<WorkspaceManifest>;
  transitionManifest(
    input: TransitionWorkspaceManifestInput,
  ): Promise<WorkspaceManifest>;
  getManifest(
    manifestId: WorkspaceManifestId,
  ): Promise<WorkspaceManifest | null>;
  getLatestManifestForRun(runId: RunId): Promise<WorkspaceManifest | null>;
}

export class WorkspaceManifestError extends Error {
  constructor(
    readonly code:
      | "immutable_identity_changed"
      | "invalid_state_transition"
      | "manifest_not_found",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceManifestError";
  }
}

export function parseWorkspaceManifest(
  value: WorkspaceManifest,
): WorkspaceManifest {
  return WorkspaceManifestSchema.parse(value);
}

export function transitionWorkspaceManifestState(
  current: WorkspaceManifestState,
  next: WorkspaceManifestState,
): WorkspaceManifestState {
  WorkspaceManifestStateSchema.parse(current);
  WorkspaceManifestStateSchema.parse(next);
  if (isAllowedTransition(current, next)) {
    return next;
  }
  throw new WorkspaceManifestError(
    "invalid_state_transition",
    `Workspace manifest cannot transition from ${current} to ${next}`,
  );
}

export function assertWorkspaceManifestIdentityUnchanged(
  current: WorkspaceManifest,
  next: WorkspaceManifest,
): void {
  for (const field of IMMUTABLE_MANIFEST_FIELDS) {
    if (current[field] !== next[field]) {
      throw new WorkspaceManifestError(
        "immutable_identity_changed",
        `Workspace manifest immutable field changed: ${field}`,
      );
    }
  }
}

function isAllowedTransition(
  current: WorkspaceManifestState,
  next: WorkspaceManifestState,
): boolean {
  return ALLOWED_STATE_TRANSITIONS[current].has(next);
}

const ALLOWED_STATE_TRANSITIONS = {
  preparing: new Set<WorkspaceManifestState>(["ready", "failed"]),
  ready: new Set<WorkspaceManifestState>(["dirty", "failed", "archived"]),
  dirty: new Set<WorkspaceManifestState>(["ready", "failed", "archived"]),
  failed: new Set<WorkspaceManifestState>(["archived"]),
  archived: new Set<WorkspaceManifestState>(),
} as const satisfies Record<
  WorkspaceManifestState,
  ReadonlySet<WorkspaceManifestState>
>;

const IMMUTABLE_MANIFEST_FIELDS = [
  "manifestId",
  "workspaceId",
  "runId",
  "userId",
  "workerId",
  "permissionProfileId",
  "repoOwner",
  "repoName",
  "repoUrl",
  "baseBranch",
  "workingBranch",
  "baseCommitSha",
  "executionLocation",
  "filesystemRoot",
  "artifactNamespace",
  "createdAt",
] as const;
