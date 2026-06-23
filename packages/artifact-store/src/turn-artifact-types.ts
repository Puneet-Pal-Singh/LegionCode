import {
  type TurnDiffPayload,
  type TurnId,
  type TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import type {
  ArtifactAccessContext,
  ArtifactMetadata,
  ArtifactOwnership,
} from "./types.js";

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
