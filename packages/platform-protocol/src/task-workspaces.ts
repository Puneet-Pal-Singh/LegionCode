import { z } from "zod";
import { ProtocolTimestampSchema } from "./common.js";
import {
  LeaseIdSchema,
  RunAttemptIdSchema,
  TaskCheckoutIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkspaceSnapshotIdSchema,
} from "./ids.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/u;
const SAFE_GIT_REF_PATTERN =
  /^(?!\/)(?!.*(?:\/\.|\/\/|@\{|\\|\.\.))(?!.*[/.]$)[A-Za-z0-9._/-]{1,240}$/u;
const SANDBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SECURE_SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{8,160}$/u;
// A checkout path is server-owned, but it still crosses a persistence boundary.
// Do not permit traversal components to become durable task identity.
const ABSOLUTE_PATH_PATTERN =
  /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?:[^/\0]+(?:\/[^/\0]+)*)?$/u;

export const ContentDigestSchema = z.string().regex(SHA256_HEX_PATTERN);
export type ContentDigest = z.infer<typeof ContentDigestSchema>;

export const GitObjectIdSchema = z.string().regex(GIT_OBJECT_ID_PATTERN);
export type GitObjectId = z.infer<typeof GitObjectIdSchema>;

export const RepositoryProviderSchema = z.enum([
  "github",
  "gitlab",
  "bitbucket",
  "generic_git",
]);
export type RepositoryProvider = z.infer<typeof RepositoryProviderSchema>;

export const RepositoryIdentitySchema = z
  .object({
    provider: RepositoryProviderSchema,
    owner: z.string().min(1).max(200).nullable(),
    name: z.string().min(1).max(200),
    canonicalUrl: z.string().url().max(2_048),
  })
  .strict()
  .readonly();
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

const AuthorizedRepositoryProvenanceSchema = z
  .object({
    kind: z.literal("authorized_repository"),
    requestedRef: z.string().regex(SAFE_GIT_REF_PATTERN),
    resolvedRef: z.string().regex(SAFE_GIT_REF_PATTERN),
    authorizedByUserId: UserIdSchema,
    authorizationContextDigest: ContentDigestSchema,
  })
  .strict();

const LocalRepositoryProvenanceSchema = z
  .object({
    kind: z.literal("local_repository"),
    sourceRootDigest: ContentDigestSchema,
    capturedByUserId: UserIdSchema,
  })
  .strict();

export const WorkspaceSnapshotProvenanceSchema = z
  .discriminatedUnion("kind", [
    AuthorizedRepositoryProvenanceSchema,
    LocalRepositoryProvenanceSchema,
  ])
  .readonly();
export type WorkspaceSnapshotProvenance = z.infer<
  typeof WorkspaceSnapshotProvenanceSchema
>;

export const WorkspaceSnapshotSchema = z
  .object({
    kind: z.literal("workspace_snapshot"),
    snapshotId: WorkspaceSnapshotIdSchema,
    workspaceId: WorkspaceIdSchema,
    repository: RepositoryIdentitySchema,
    authorizedCommitId: GitObjectIdSchema,
    authorizedTreeId: GitObjectIdSchema,
    manifestDigest: ContentDigestSchema,
    configDigest: ContentDigestSchema,
    capturedAt: ProtocolTimestampSchema,
    provenance: WorkspaceSnapshotProvenanceSchema,
  })
  .strict()
  .readonly();
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const TaskCheckoutStatusSchema = z.enum([
  "ready",
  "active",
  "settled",
  "failed",
]);
export type TaskCheckoutStatus = z.infer<typeof TaskCheckoutStatusSchema>;

const TaskCheckoutBindingShape = {
  kind: z.literal("task_checkout"),
  checkoutId: TaskCheckoutIdSchema,
  snapshotId: WorkspaceSnapshotIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  secureSessionId: z.string().regex(SECURE_SESSION_ID_PATTERN),
  leaseId: LeaseIdSchema,
  sandboxId: z.string().regex(SANDBOX_ID_PATTERN),
  filesystemRoot: z.string().max(2_048).regex(ABSOLUTE_PATH_PATTERN),
  gitDir: z.string().max(2_048).regex(ABSOLUTE_PATH_PATTERN),
  indexFile: z.string().max(2_048).regex(ABSOLUTE_PATH_PATTERN),
  workingBranch: z.string().regex(SAFE_GIT_REF_PATTERN),
  startTreeId: GitObjectIdSchema,
  generation: z.number().int().safe().nonnegative(),
  createdAt: ProtocolTimestampSchema,
} as const;

const ReadyTaskCheckoutSchema = z
  .object({
    ...TaskCheckoutBindingShape,
    status: z.literal("ready"),
    settledAt: z.null(),
    failureCode: z.null(),
  })
  .strict();

const ActiveTaskCheckoutSchema = z
  .object({
    ...TaskCheckoutBindingShape,
    status: z.literal("active"),
    settledAt: z.null(),
    failureCode: z.null(),
  })
  .strict();

const SettledTaskCheckoutSchema = z
  .object({
    ...TaskCheckoutBindingShape,
    status: z.literal("settled"),
    settledAt: ProtocolTimestampSchema,
    failureCode: z.null(),
  })
  .strict();

const FailedTaskCheckoutSchema = z
  .object({
    ...TaskCheckoutBindingShape,
    status: z.literal("failed"),
    settledAt: ProtocolTimestampSchema,
    failureCode: z.string().min(1).max(120),
  })
  .strict();

export const TaskCheckoutSchema = z
  .discriminatedUnion("status", [
    ReadyTaskCheckoutSchema,
    ActiveTaskCheckoutSchema,
    SettledTaskCheckoutSchema,
    FailedTaskCheckoutSchema,
  ])
  .superRefine((checkout, context) => {
    if (
      checkout.filesystemRoot === checkout.gitDir ||
      checkout.filesystemRoot === checkout.indexFile ||
      checkout.gitDir === checkout.indexFile
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Task checkout filesystem root, Git directory, and index file must be distinct",
      });
    }
  })
  .readonly();
export type TaskCheckout = z.infer<typeof TaskCheckoutSchema>;
