import {
  GitCommitShaSchema,
  PermissionProfileIdSchema,
  ProtocolTimestampSchema,
  RunIdSchema,
  WorkerExecutionLocationSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
} from "@repo/platform-protocol";
import { z, type ZodIssue } from "zod";
import {
  createImmutableFieldChangedError,
  createInvalidManifestError,
  createMissingRunIdError,
} from "./errors.js";
import {
  assertValidWorkspaceTransition,
  WorkspaceStateSchema,
  type WorkspaceTransitionOptions,
} from "./state-machine.js";

const BranchNameSchema = z.string().min(1).max(240);
const FilesystemRootSchema = z.string().min(1).max(2_048);
const ArtifactNamespaceSchema = z.string().min(1).max(512);

export const WorkspaceManifestSchema = z
  .object({
    runId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    repoOwner: z.string().min(1).max(200),
    repoName: z.string().min(1).max(200),
    repoUrl: z.string().url(),
    baseBranch: BranchNameSchema,
    workingBranch: BranchNameSchema,
    baseSha: GitCommitShaSchema,
    headSha: GitCommitShaSchema,
    executionLocation: WorkerExecutionLocationSchema,
    workerId: WorkerIdSchema,
    filesystemRoot: FilesystemRootSchema,
    artifactNamespace: ArtifactNamespaceSchema,
    permissionProfileId: PermissionProfileIdSchema,
    state: WorkspaceStateSchema,
    lastError: z.string().min(1).max(2_000).nullable(),
    createdAt: ProtocolTimestampSchema,
    updatedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const IMMUTABLE_WORKSPACE_MANIFEST_FIELDS = [
  "runId",
  "workspaceId",
  "repoOwner",
  "repoName",
  "repoUrl",
  "baseBranch",
  "workingBranch",
  "baseSha",
  "executionLocation",
  "workerId",
  "filesystemRoot",
  "artifactNamespace",
  "permissionProfileId",
  "createdAt",
] as const satisfies readonly (keyof WorkspaceManifest)[];
export type ImmutableWorkspaceManifestField =
  (typeof IMMUTABLE_WORKSPACE_MANIFEST_FIELDS)[number];

export function parseWorkspaceManifest(input: unknown): WorkspaceManifest {
  const result = WorkspaceManifestSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  if (hasMissingRunIdIssue(result.error.issues)) {
    throw createMissingRunIdError();
  }

  throw createInvalidManifestError(formatIssues(result.error.issues));
}

export function assertWorkspaceManifestImmutableFieldsUnchanged(
  current: WorkspaceManifest,
  next: WorkspaceManifest,
): void {
  const changedFields = findChangedImmutableFields(current, next);
  if (changedFields.length > 0) {
    throw createImmutableFieldChangedError(changedFields);
  }
}

export function validateWorkspaceManifestUpdate(
  currentInput: unknown,
  nextInput: unknown,
  options: WorkspaceTransitionOptions = {},
): WorkspaceManifest {
  const current = parseWorkspaceManifest(currentInput);
  const next = parseWorkspaceManifest(nextInput);

  assertWorkspaceManifestImmutableFieldsUnchanged(current, next);
  if (current.state !== next.state) {
    assertValidWorkspaceTransition(current.state, next.state, options);
  }

  return next;
}

function findChangedImmutableFields(
  current: WorkspaceManifest,
  next: WorkspaceManifest,
): readonly string[] {
  return IMMUTABLE_WORKSPACE_MANIFEST_FIELDS.filter(
    (field) => current[field] !== next[field],
  );
}

function hasMissingRunIdIssue(issues: readonly ZodIssue[]): boolean {
  return issues.some(isMissingRunIdIssue);
}

function isMissingRunIdIssue(issue: ZodIssue): boolean {
  return (
    issue.path.length === 1 &&
    issue.path[0] === "runId" &&
    issue.code === z.ZodIssueCode.invalid_type &&
    "received" in issue &&
    issue.received === "undefined"
  );
}

function formatIssues(issues: readonly ZodIssue[]): readonly string[] {
  return issues.map(formatIssue);
}

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.join(".");
  if (path.length === 0) {
    return issue.message;
  }

  return `${path}: ${issue.message}`;
}
