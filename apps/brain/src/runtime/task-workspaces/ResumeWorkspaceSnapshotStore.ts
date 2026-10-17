import type { R2Bucket } from "@cloudflare/workers-types";
import {
  ResumeWorkspaceSnapshotRefSchema,
  type ResumeWorkspaceSnapshotRef,
} from "@repo/platform-protocol";

interface ResumeSnapshotObject {
  readonly customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const MAX_SNAPSHOT_BYTES = 5_000_000;
export { ResumeWorkspaceSnapshotRefSchema, type ResumeWorkspaceSnapshotRef };

export class ResumeWorkspaceSnapshotStore {
  constructor(private readonly bucket: R2Bucket) {}

  async write(input: {
    readonly userId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly sourceRunId: string;
    readonly sourceTurnId: string;
    readonly sourceRunAttemptId: string;
    readonly baseSnapshotId: string;
    readonly baseCommitSha: string;
    readonly terminalTreeSha: string;
    readonly patch: string;
  }): Promise<ResumeWorkspaceSnapshotRef> {
    const bytes = new TextEncoder().encode(input.patch);
    if (
      bytes.byteLength > MAX_SNAPSHOT_BYTES ||
      input.patch.length > MAX_SNAPSHOT_BYTES
    ) {
      throw new Error("Workspace snapshot exceeds the artifact size limit");
    }
    const digest = await sha256Hex(bytes);
    const artifactId = `art_${(await sha256Hex(
      new TextEncoder().encode(
        `${input.sourceRunId}\0${input.sourceTurnId}\0${input.sourceRunAttemptId}`,
      ),
    )).slice(0, 48)}`;
    const payloadObjectKey = snapshotObjectKey({
      userId: input.userId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sourceRunId: input.sourceRunId,
      sourceTurnId: input.sourceTurnId,
      sourceRunAttemptId: input.sourceRunAttemptId,
      artifactId,
    });
    const ref = ResumeWorkspaceSnapshotRefSchema.parse({
      schemaVersion: 1,
      artifactId,
      payloadObjectKey,
      userId: input.userId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sourceRunId: input.sourceRunId,
      sourceTurnId: input.sourceTurnId,
      sourceRunAttemptId: input.sourceRunAttemptId,
      baseSnapshotId: input.baseSnapshotId,
      baseCommitSha: input.baseCommitSha,
      terminalTreeSha: input.terminalTreeSha,
      patchSha256: digest,
      byteLength: bytes.byteLength,
    });
    const existing = await this.bucket.get(objectKey(ref));
    if (existing) {
      await this.assertObjectMatches(existing, ref);
      return ref;
    }
    await this.bucket.put(objectKey(ref), bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        schemaVersion: String(ref.schemaVersion),
        artifactId: ref.artifactId,
        payloadObjectKey: ref.payloadObjectKey,
        userId: ref.userId,
        workspaceId: ref.workspaceId,
        threadId: ref.threadId,
        sourceRunId: ref.sourceRunId,
        sourceTurnId: ref.sourceTurnId,
        sourceRunAttemptId: ref.sourceRunAttemptId,
        baseSnapshotId: ref.baseSnapshotId,
        baseCommitSha: ref.baseCommitSha,
        terminalTreeSha: ref.terminalTreeSha,
        patchSha256: ref.patchSha256,
        byteLength: String(ref.byteLength),
      },
    });
    const persisted = await this.bucket.get(objectKey(ref));
    if (!persisted) throw new Error("Workspace snapshot artifact is missing after write");
    await this.assertObjectMatches(persisted, ref);
    return ref;
  }

  async read(
    rawRef: ResumeWorkspaceSnapshotRef,
    scope: {
      readonly userId: string;
      readonly workspaceId: string;
      readonly threadId: string;
    },
  ): Promise<string> {
    const ref = ResumeWorkspaceSnapshotRefSchema.parse(rawRef);
    if (
      ref.userId !== scope.userId ||
      ref.workspaceId !== scope.workspaceId ||
      ref.threadId !== scope.threadId
    ) {
      throw new Error("Workspace snapshot access scope does not match");
    }
    const object = await this.bucket.get(objectKey(ref));
    if (!object) throw new Error("Workspace snapshot artifact is missing");
    const bytes = await this.assertObjectMatches(object, ref);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private async assertObjectMatches(
    object: ResumeSnapshotObject,
    ref: ResumeWorkspaceSnapshotRef,
  ): Promise<Uint8Array> {
    const metadata = object.customMetadata ?? {};
    if (
      metadata.schemaVersion !== String(ref.schemaVersion) ||
      metadata.artifactId !== ref.artifactId ||
      metadata.payloadObjectKey !== ref.payloadObjectKey ||
      metadata.userId !== ref.userId ||
      metadata.workspaceId !== ref.workspaceId ||
      metadata.threadId !== ref.threadId ||
      metadata.sourceRunId !== ref.sourceRunId ||
      metadata.sourceTurnId !== ref.sourceTurnId ||
      metadata.sourceRunAttemptId !== ref.sourceRunAttemptId ||
      metadata.baseSnapshotId !== ref.baseSnapshotId ||
      metadata.baseCommitSha !== ref.baseCommitSha ||
      metadata.terminalTreeSha !== ref.terminalTreeSha ||
      metadata.patchSha256 !== ref.patchSha256 ||
      metadata.byteLength !== String(ref.byteLength)
    ) {
      throw new Error("Workspace snapshot artifact metadata did not match");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (
      bytes.byteLength !== ref.byteLength ||
      (await sha256Hex(bytes)) !== ref.patchSha256
    ) {
      throw new Error(
        "Workspace snapshot artifact failed integrity validation",
      );
    }
    return bytes;
  }
}

function objectKey(ref: ResumeWorkspaceSnapshotRef): string {
  if (ref.payloadObjectKey !== snapshotObjectKey(ref)) {
    throw new Error("Workspace snapshot object key does not match its scope");
  }
  return ref.payloadObjectKey;
}

function snapshotObjectKey(input: {
  readonly userId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceRunAttemptId: string;
  readonly artifactId: string;
}): string {
  return [
    "resume-workspace-snapshots",
    encodePathSegment(input.userId),
    encodePathSegment(input.workspaceId),
    encodePathSegment(input.threadId),
    encodePathSegment(input.sourceRunId),
    encodePathSegment(input.sourceTurnId),
    encodePathSegment(input.sourceRunAttemptId),
    input.artifactId,
    "workspace.patch",
  ].join("/");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = new Uint8Array(bytes.byteLength);
  content.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", content.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
