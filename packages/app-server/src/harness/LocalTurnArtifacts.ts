import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  ArtifactIdSchema, ArtifactMetadataSchema, EVENT_SCHEMA_VERSION, TurnDiffPayloadSchema, TurnWorkspaceSnapshotSchema,
  type ArtifactMetadata, type TurnDiffPayload, type TurnId,
} from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import type { RuntimeTurnArtifactPort } from "@repo/runtime-kernel";

/** Canonical artifact metadata uses the existing SQLite event writer. Immutable
 * content-addressed blobs are payloads only, never a lifecycle/history authority.
 */
export class LocalTurnArtifacts implements RuntimeTurnArtifactPort {
  constructor(private readonly persistence: LocalPersistence, private readonly storageDirectory: string) {
    if (!isAbsolute(storageDirectory)) throw new Error("Local artifact storage requires an absolute directory");
  }
  async putSnapshot(input: Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0]): Promise<ArtifactMetadata> {
    const snapshot = TurnWorkspaceSnapshotSchema.parse(input.snapshot);
    await this.authorize(snapshot.turnId, input);
    return this.put(snapshot.turnId, `snapshot:${snapshot.phase}`, snapshot,
      input.ownership, snapshot.capturedAt, []);
  }
  async putTurnDiff(input: Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0]): Promise<ArtifactMetadata> {
    await this.authorize(input.diff.turnId, input);
    const diff = TurnDiffPayloadSchema.parse(input.diff);
    return this.put(diff.turnId, "diff", diff, input.ownership, diff.terminalSnapshot.capturedAt, diff.files);
  }
  async readDiff(turnId: TurnId): Promise<TurnDiffPayload | null> {
    const admission = await this.persistence.turnAdmissions.getByTurn(turnId);
    if (!admission) throw new Error("Local artifact admission was not found");
    const events = await this.persistence.events.listAll();
    const event = events.find((value) => value.type === "artifact.created" &&
      value.payload.artifact.metadata.turnId === turnId && value.payload.artifact.metadata.role === "turn_diff");
    if (!event || event.type !== "artifact.created") return null;
    const artifact = event.payload.artifact;
    if (artifact.runId !== admission.run.id || artifact.threadId !== admission.run.threadId ||
        artifact.workspaceId !== admission.run.workspaceId || artifact.metadata.createdBy !== admission.run.userId ||
        artifact.payloadRef.backend !== "local_blob") throw new Error("Local artifact ownership does not match admission");
    const key = /^sha256:([a-f0-9]{64})$/.exec(artifact.payloadRef.objectKey)?.[1];
    if (!key) throw new Error("Local artifact payload reference is invalid");
    const payloadPath = join(await this.directory(), key.slice(0, 2), key);
    if (await realpath(payloadPath) !== payloadPath) throw new Error("Local artifact payload cannot redirect through a symlink");
    const bytes = await readFile(payloadPath);
    if (bytes.length !== artifact.payloadRef.sizeBytes || digest(bytes) !== artifact.payloadRef.sha256) {
      throw new Error("Local artifact payload is missing or corrupt");
    }
    const diff = TurnDiffPayloadSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (diff.turnId !== turnId) throw new Error("Local diff payload belongs to a different turn");
    return diff;
  }
  private async authorize(turnId: TurnId, input: Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0] | Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0]): Promise<void> {
    const admission = await this.persistence.turnAdmissions.getByTurn(turnId);
    const { ownership, access } = input;
    if (!admission || ownership.createdBy !== admission.run.userId || access.userId !== admission.run.userId ||
        ownership.runId !== admission.run.id || access.runId !== admission.run.id ||
        ownership.threadId !== admission.run.threadId || access.threadId !== admission.run.threadId ||
        ownership.workspaceId !== admission.run.workspaceId || access.workspaceId !== admission.run.workspaceId) {
      throw new Error("Local artifact access does not match canonical admission");
    }
  }
  private async put(turnId: TurnId, role: string, payload: unknown,
    ownership: Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0]["ownership"], capturedAt: string,
    files: TurnDiffPayload["files"]): Promise<ArtifactMetadata> {
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Local artifact payload exceeds its size bound");
    const sha256 = digest(bytes);
    const idempotencyKey = `turn:${turnId}:${role}`;
    const events = await this.persistence.events.listAll();
    const existing = events.find((event) => event.type === "artifact.created" && event.idempotencyKey === idempotencyKey);
    if (existing && existing.type === "artifact.created") {
      if (existing.payload.artifact.payloadRef.sha256 !== sha256 || existing.payload.artifact.metadata.createdBy !== ownership.createdBy) {
        throw new Error("Immutable local artifact already has different content");
      }
      return existing.payload.artifact;
    }
    const directory = join(await this.directory(), sha256.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("Local artifact shard cannot redirect through a symlink");
    const path = join(directory, sha256);
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (digest(await readFile(path)) !== sha256) throw new Error("Local artifact blob checksum conflict");
    }
    const artifact = ArtifactMetadataSchema.parse({
      artifactId: ArtifactIdSchema.parse(`art_${digest(Buffer.from(idempotencyKey)).slice(0, 32)}`),
      threadId: ownership.threadId, runId: ownership.runId, workspaceId: ownership.workspaceId, itemId: null,
      kind: role === "diff" ? "diff" : "workspace_snapshot", label: role === "diff" ? "Turn diff" : "Turn workspace snapshot",
      payloadRef: { backend: "local_blob", objectKey: `sha256:${sha256}`, uri: null,
        contentType: "application/json", sizeBytes: bytes.length, sha256 }, changedFiles: files,
      metadata: { role: role === "diff" ? "turn_diff" : "turn_snapshot", phase: role, turnId, createdBy: ownership.createdBy },
      createdAt: capturedAt, eventSequence: 1,
    });
    const event = await this.persistence.events.append({
      threadId: ownership.threadId, workspaceId: ownership.workspaceId, runId: ownership.runId,
      scopeType: "artifact", scopeId: artifact.artifactId, type: "artifact.created", payload: { itemId: null, artifact },
      idempotencyKey, producer: { kind: "runtime_kernel", id: "local-turn-artifacts" }, schemaVersion: EVENT_SCHEMA_VERSION,
    });
    if (event.type !== "artifact.created") throw new Error("Local artifact append returned a different record");
    return event.payload.artifact;
  }
  private async directory(): Promise<string> {
    const root = await realpath(this.storageDirectory);
    const grant = await this.persistence.workspaceGrants.read();
    if (grant) {
      const workspace = await realpath(grant.path);
      const child = relative(workspace, root);
      if (child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))) {
        throw new Error("Local artifact storage cannot be inside the granted workspace");
      }
    }
    const directory = join(root, "turn-artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("Local artifact directory cannot redirect through a symlink");
    return directory;
  }
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
