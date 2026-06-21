import { TurnIdSchema, type JsonRecord } from "@repo/platform-protocol";
import type {
  ArtifactAccessContext,
  ArtifactMetadata,
  ArtifactStore,
  PutArtifactInput,
} from "./types.js";
import { ArtifactStoreError } from "./errors.js";
import {
  TurnDiffPayloadSchema,
  TurnWorkspaceSnapshotSchema,
  type PutTurnDiffInput,
  type PutTurnSnapshotInput,
  type StoredTurnDiff,
  type TurnArtifactRepository,
  type TurnDiffPayload,
} from "./turn-artifact-types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class DefaultTurnArtifactStore implements TurnArtifactRepository {
  constructor(private readonly artifacts: ArtifactStore) {}

  async putSnapshot(input: PutTurnSnapshotInput): Promise<ArtifactMetadata> {
    const snapshot = TurnWorkspaceSnapshotSchema.parse(input.snapshot);
    return await this.artifacts.put(
      {
        idempotencyKey: `turn:${snapshot.turnId}:snapshot:${snapshot.phase}:${snapshot.treeId}`,
        kind: "workspace_snapshot",
        ownership: input.ownership,
        visibility: "run",
        contentType: "application/json",
        payload: encode(snapshot),
        properties: properties("turn_snapshot", snapshot.turnId, {
          phase: snapshot.phase,
          treeId: snapshot.treeId,
        }),
      },
      input.access,
    );
  }

  async putTurnDiff(input: PutTurnDiffInput): Promise<ArtifactMetadata> {
    const diff = TurnDiffPayloadSchema.parse(input.diff);
    const artifact: PutArtifactInput = {
      idempotencyKey: `turn:${diff.turnId}:diff:${diff.terminalSnapshot.treeId}`,
      kind: "diff",
      ownership: input.ownership,
      visibility: "run",
      contentType: "application/json",
      payload: encode(diff),
      properties: properties("turn_diff", diff.turnId, {
        changedFileCount: diff.files.length,
      }),
    };
    return await this.artifacts.put(artifact, input.access);
  }

  async getTurnDiff(
    turnId: ReturnType<typeof TurnIdSchema.parse>,
    access: ArtifactAccessContext,
  ): Promise<StoredTurnDiff | null> {
    const parsedTurnId = TurnIdSchema.parse(turnId);
    const metadata = (await this.artifacts.list(access)).find((artifact) =>
      isTurnDiff(artifact, parsedTurnId),
    );
    return metadata ? await this.readDiff(metadata, access) : null;
  }

  async listWorkspaceDiffs(
    access: ArtifactAccessContext,
  ): Promise<StoredTurnDiff[]> {
    const metadata = (await this.artifacts.list(access)).filter((artifact) =>
      isTurnDiff(artifact),
    );
    return await Promise.all(
      metadata.map((artifact) => this.readDiff(artifact, access)),
    );
  }

  private async readDiff(
    metadata: ArtifactMetadata,
    access: ArtifactAccessContext,
  ): Promise<StoredTurnDiff> {
    const payload = await this.artifacts.getPayload(
      metadata.artifactId,
      access,
    );
    if (!payload) {
      throw new ArtifactStoreError(
        "artifact_payload_not_found",
        `Turn diff payload is missing: ${metadata.artifactId}`,
      );
    }
    return { metadata, payload: decode(payload) };
  }
}

function properties(
  role: "turn_snapshot" | "turn_diff",
  turnId: string,
  values: JsonRecord,
): JsonRecord {
  return { role, turnId, ...values };
}

function isTurnDiff(metadata: ArtifactMetadata, turnId?: string): boolean {
  return (
    metadata.properties.role === "turn_diff" &&
    (turnId === undefined || metadata.properties.turnId === turnId)
  );
}

function encode(
  value: TurnDiffPayload | PutTurnSnapshotInput["snapshot"],
): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decode(value: Uint8Array): TurnDiffPayload {
  return TurnDiffPayloadSchema.parse(JSON.parse(decoder.decode(value)));
}
