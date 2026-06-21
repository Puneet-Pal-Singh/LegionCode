import {
  ProtocolTimestampSchema,
  TurnIdSchema,
  type TurnId,
} from "@repo/platform-protocol";
import { z } from "zod";
import type {
  ArtifactAccessContext,
  ArtifactMetadata,
  ArtifactOwnership,
} from "./types.js";

const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const TurnSnapshotPhaseSchema = z.enum(["start", "terminal"]);
export type TurnSnapshotPhase = z.infer<typeof TurnSnapshotPhaseSchema>;

export const TurnWorkspaceSnapshotSchema = z
  .object({
    turnId: TurnIdSchema,
    snapshotKey: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u),
    treeId: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
    phase: TurnSnapshotPhaseSchema,
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type TurnWorkspaceSnapshot = z.infer<typeof TurnWorkspaceSnapshotSchema>;

export const TurnDiffFileSchema = z
  .object({
    path: z.string().min(1).max(2_048),
    previousPath: z.string().min(1).max(2_048).nullable(),
    status: z.enum([
      "added",
      "copied",
      "deleted",
      "modified",
      "renamed",
      "type_changed",
      "unmerged",
      "untracked",
    ]),
    additions: z.number().int().safe().nonnegative(),
    deletions: z.number().int().safe().nonnegative(),
  })
  .strict();
export type TurnDiffFile = z.infer<typeof TurnDiffFileSchema>;

export const TurnDiffPayloadSchema = z
  .object({
    turnId: TurnIdSchema,
    startSnapshot: TurnWorkspaceSnapshotSchema,
    terminalSnapshot: TurnWorkspaceSnapshotSchema,
    files: z.array(TurnDiffFileSchema).max(2_000),
    patch: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startSnapshot.turnId !== value.turnId) {
      context.addIssue({
        code: "custom",
        message: "Start snapshot turn mismatch",
      });
    }
    if (value.terminalSnapshot.turnId !== value.turnId) {
      context.addIssue({
        code: "custom",
        message: "Terminal snapshot turn mismatch",
      });
    }
  });
export type TurnDiffPayload = z.infer<typeof TurnDiffPayloadSchema>;

export interface PutTurnSnapshotInput {
  readonly snapshot: TurnWorkspaceSnapshot;
  readonly ownership: ArtifactOwnership;
  readonly access: ArtifactAccessContext;
}

export interface PutTurnDiffInput {
  readonly diff: TurnDiffPayload;
  readonly ownership: ArtifactOwnership;
  readonly access: ArtifactAccessContext;
}

export interface StoredTurnDiff {
  readonly metadata: ArtifactMetadata;
  readonly payload: TurnDiffPayload;
}

export interface TurnArtifactRepository {
  putSnapshot(input: PutTurnSnapshotInput): Promise<ArtifactMetadata>;
  putTurnDiff(input: PutTurnDiffInput): Promise<ArtifactMetadata>;
  getTurnDiff(
    turnId: TurnId,
    access: ArtifactAccessContext,
  ): Promise<StoredTurnDiff | null>;
  listWorkspaceDiffs(access: ArtifactAccessContext): Promise<StoredTurnDiff[]>;
}
