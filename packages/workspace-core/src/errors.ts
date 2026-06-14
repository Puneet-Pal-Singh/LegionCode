export type WorkspaceCoreErrorCode =
  | "workspace_manifest_already_exists"
  | "workspace_manifest_not_found"
  | "workspace_immutable_field_changed"
  | "workspace_manifest_invalid"
  | "workspace_missing_run_id"
  | "workspace_transition_invalid";

export type WorkspaceCoreErrorContextValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export type WorkspaceCoreErrorContext = Readonly<
  Record<string, WorkspaceCoreErrorContextValue>
>;

export class WorkspaceCoreError extends Error {
  readonly code: WorkspaceCoreErrorCode;
  readonly context: WorkspaceCoreErrorContext;

  constructor(
    code: WorkspaceCoreErrorCode,
    message: string,
    context: WorkspaceCoreErrorContext = {},
  ) {
    super(message);
    this.name = "WorkspaceCoreError";
    this.code = code;
    this.context = context;
  }
}

export function createInvalidManifestError(
  issues: readonly string[],
): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_manifest_invalid",
    "Workspace manifest is invalid",
    { issues },
  );
}

export function createManifestAlreadyExistsError(
  workspaceId: string,
): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_manifest_already_exists",
    "Workspace manifest already exists",
    { workspaceId },
  );
}

export function createManifestNotFoundError(
  workspaceId: string,
): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_manifest_not_found",
    "Workspace manifest does not exist",
    { workspaceId },
  );
}

export function createMissingRunIdError(): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_missing_run_id",
    "Workspace manifest requires a runId",
  );
}

export function createImmutableFieldChangedError(
  changedFields: readonly string[],
): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_immutable_field_changed",
    "Workspace manifest immutable fields changed",
    { changedFields },
  );
}

export function createInvalidTransitionError(
  fromState: string,
  toState: string,
  reason: string,
): WorkspaceCoreError {
  return new WorkspaceCoreError(
    "workspace_transition_invalid",
    "Workspace state transition is invalid",
    { fromState, reason, toState },
  );
}
