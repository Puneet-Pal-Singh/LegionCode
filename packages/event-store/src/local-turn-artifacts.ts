import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  ArtifactIdSchema,
  ArtifactMetadataSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
  TurnWorkspaceSnapshotSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type TurnDiffPayload,
  type TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import { z } from "zod";
import { EventStoreError, LocalPersistenceError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";

const PREFIX = "turn_artifact_v1:";
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ScopeSchema = z
  .object({
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
  })
  .strict();
export type LocalTurnArtifactScope = z.infer<typeof ScopeSchema>;
const ReferenceSchema = ArtifactMetadataSchema.omit({ eventSequence: true });
const RecordSchema = z
  .object({
    version: z.literal(1),
    scope: ScopeSchema,
    artifact: ReferenceSchema,
    payload: z.discriminatedUnion("role", [
      z
        .object({
          role: z.literal("start"),
          value: TurnWorkspaceSnapshotSchema,
        })
        .strict(),
      z
        .object({
          role: z.literal("terminal"),
          value: TurnWorkspaceSnapshotSchema,
        })
        .strict(),
      z
        .object({ role: z.literal("diff"), value: TurnDiffPayloadSchema })
        .strict(),
    ]),
  })
  .strict();
type StoredRecord = z.infer<typeof RecordSchema>;
type Role = StoredRecord["payload"]["role"];
type Access = Omit<LocalTurnArtifactScope, "turnId" | "runAttemptId">;
type Ownership = Omit<Access, "userId"> & { createdBy: Access["userId"] };
type Guard = <T>(operation: () => T) => T;

/** Uses the process-owned LocalPersistence database, never another SQLite writer. */
export function createLocalTurnArtifactStore(
  database: Database.Database,
  guard: Guard,
) {
  return {
    forAttempt(input: LocalTurnArtifactScope) {
      const scope = ScopeSchema.parse(input);
      const read = (role: Role) =>
        guard(() => {
          const record = readRecord(database, scope, role);
          if (record?.payload.role === "diff")
            requireCapturedSnapshots(database, scope, record.payload.value);
          return record;
        });
      const put = (
        payload: StoredRecord["payload"],
        ownership: Ownership,
        access: Access,
      ) => {
        requireOwnership(scope, ownership, access);
        return guard(() =>
          database
            .transaction(() => {
              validatePayload(scope, payload);
              if (payload.role === "diff")
                requireCapturedSnapshots(database, scope, payload.value);
              const existing = readRecord(database, scope, payload.role);
              if (existing) {
                if (encode(existing.payload) !== encode(payload)) {
                  throw new EventStoreError(
                    "idempotency_conflict",
                    "Turn artifact already contains different immutable content",
                  );
                }
                return existing.artifact;
              }
              const bytes = Buffer.from(encode(payload.value));
              if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
                throw new LocalPersistenceError(
                  "unavailable",
                  "Turn artifact exceeds local payload size limit",
                );
              }
              const key = storageKey(scope, payload.role);
              const artifact = ReferenceSchema.parse({
                artifactId: ArtifactIdSchema.parse(`art_${randomUUID()}`),
                threadId: scope.threadId,
                runId: scope.runId,
                workspaceId: scope.workspaceId,
                itemId: null,
                kind: payload.role === "diff" ? "diff" : "workspace_snapshot",
                label:
                  payload.role === "diff"
                    ? "Turn changes"
                    : `${payload.role} workspace snapshot`,
                payloadRef: {
                  backend: "local_blob",
                  objectKey: key,
                  uri: null,
                  contentType: "application/json",
                  sizeBytes: bytes.byteLength,
                  sha256: hash(bytes),
                },
                changedFiles:
                  payload.role === "diff" ? payload.value.files : [],
                metadata: {
                  turnId: scope.turnId,
                  runAttemptId: scope.runAttemptId,
                  role: payload.role,
                },
                createdAt:
                  payload.role === "diff"
                    ? payload.value.terminalSnapshot.capturedAt
                    : payload.value.capturedAt,
              });
              const record = RecordSchema.parse({
                version: 1,
                scope,
                artifact,
                payload,
              });
              database
                .prepare("INSERT INTO metadata(key, value) VALUES (?, ?)")
                .run(key, encode(record));
              return artifact;
            })
            .immediate(),
        );
      };
      return {
        async putSnapshot(input: {
          snapshot: TurnWorkspaceSnapshot;
          ownership: Ownership;
          access: Access;
        }) {
          const snapshot = TurnWorkspaceSnapshotSchema.parse(input.snapshot);
          return put(
            { role: snapshot.phase, value: snapshot },
            input.ownership,
            input.access,
          );
        },
        async putTurnDiff(input: {
          diff: TurnDiffPayload;
          ownership: Ownership;
          access: Access;
        }) {
          return put(
            { role: "diff", value: TurnDiffPayloadSchema.parse(input.diff) },
            input.ownership,
            input.access,
          );
        },
        async getSnapshot(phase: "start" | "terminal") {
          if (phase !== "start" && phase !== "terminal")
            throw new Error("Invalid snapshot phase");
          const record = read(phase);
          return record && record.payload.role !== "diff"
            ? { artifact: record.artifact, snapshot: record.payload.value }
            : null;
        },
        async getPayload(artifactId: string) {
          const id = ArtifactIdSchema.parse(artifactId);
          for (const role of ["start", "terminal", "diff"] as const) {
            const record = read(role);
            if (record?.artifact.artifactId === id)
              return new Uint8Array(Buffer.from(encode(record.payload.value)));
          }
          return null;
        },
        async getTurnDiff() {
          const record = read("diff");
          return record?.payload.role === "diff"
            ? { artifact: record.artifact, diff: record.payload.value }
            : null;
        },
      };
    },
  };
}

/** Call during LocalPersistence validation, including before mutating an existing DB. */
export function validateLocalTurnArtifacts(database: Database.Database): void {
  const rows = database
    .prepare("SELECT key, value FROM metadata WHERE substr(key, 1, ?) = ?")
    .all(PREFIX.length, PREFIX) as { key: string; value: string }[];
  for (const row of rows) {
    const record = parseRecord(row.key, row.value);
    if (record.payload.role === "diff") {
      try {
        requireCapturedSnapshots(database, record.scope, record.payload.value);
      } catch {
        throw corrupt();
      }
    }
  }
}

function readRecord(
  database: Database.Database,
  scope: LocalTurnArtifactScope,
  role: Role,
): StoredRecord | null {
  const key = storageKey(scope, role);
  const row = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  const record = parseRecord(key, row.value);
  if (encode(record.scope) !== encode(scope) || record.payload.role !== role)
    throw corrupt();
  return record;
}

function parseRecord(key: string, value: string): StoredRecord {
  try {
    const record = RecordSchema.parse(JSON.parse(value));
    const { scope, payload, artifact } = record;
    validatePayload(scope, payload);
    const bytes = Buffer.from(encode(payload.value));
    if (
      key !== storageKey(scope, payload.role) ||
      artifact.payloadRef.objectKey !== key ||
      artifact.payloadRef.backend !== "local_blob" ||
      artifact.payloadRef.uri !== null ||
      artifact.payloadRef.contentType !== "application/json" ||
      artifact.payloadRef.sizeBytes !== bytes.byteLength ||
      artifact.payloadRef.sha256 !== hash(bytes) ||
      artifact.threadId !== scope.threadId ||
      artifact.runId !== scope.runId ||
      artifact.workspaceId !== scope.workspaceId ||
      artifact.metadata.turnId !== scope.turnId ||
      artifact.metadata.runAttemptId !== scope.runAttemptId ||
      artifact.metadata.role !== payload.role ||
      artifact.kind !==
        (payload.role === "diff" ? "diff" : "workspace_snapshot") ||
      encode(artifact.changedFiles) !==
        encode(payload.role === "diff" ? payload.value.files : []) ||
      bytes.byteLength > MAX_PAYLOAD_BYTES
    )
      throw corrupt();
    return record;
  } catch {
    throw corrupt();
  }
}

function validatePayload(
  scope: LocalTurnArtifactScope,
  payload: StoredRecord["payload"],
): void {
  if (payload.value.turnId !== scope.turnId)
    throw new Error("Turn artifact scope mismatch");
  if (payload.role === "diff") {
    if (
      payload.value.startSnapshot.phase !== "start" ||
      payload.value.terminalSnapshot.phase !== "terminal"
    ) {
      throw new Error("Turn diff snapshot phases are invalid");
    }
    for (const file of payload.value.files) {
      requireRelativePath(file.path);
      if (file.previousPath !== null) requireRelativePath(file.previousPath);
    }
  } else if (payload.value.phase !== payload.role)
    throw new Error("Snapshot phase mismatch");
}

function requireCapturedSnapshots(
  database: Database.Database,
  scope: LocalTurnArtifactScope,
  diff: TurnDiffPayload,
): void {
  const start = readRecord(database, scope, "start");
  const terminal = readRecord(database, scope, "terminal");
  if (
    !start ||
    !terminal ||
    encode(start.payload.value) !== encode(diff.startSnapshot) ||
    encode(terminal.payload.value) !== encode(diff.terminalSnapshot)
  ) {
    throw new EventStoreError(
      "idempotency_conflict",
      "Turn diff must reference its persisted baseline and final captures",
    );
  }
}

function requireRelativePath(path: string): void {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git",
      )
  ) {
    throw new Error("Turn artifact path must remain inside the workspace");
  }
}

function requireOwnership(
  scope: LocalTurnArtifactScope,
  ownership: Ownership,
  access: Access,
): void {
  if (
    ownership.createdBy !== scope.userId ||
    access.userId !== scope.userId ||
    ownership.workspaceId !== scope.workspaceId ||
    access.workspaceId !== scope.workspaceId ||
    ownership.threadId !== scope.threadId ||
    access.threadId !== scope.threadId ||
    ownership.runId !== scope.runId ||
    access.runId !== scope.runId
  ) {
    throw new Error("Turn artifact access must match its bound attempt scope");
  }
}

function storageKey(scope: LocalTurnArtifactScope, role: Role): string {
  return `${PREFIX}${hash(encode({ scope, role }))}`;
}
function encode(value: unknown): string {
  return createStableEventFingerprint(value);
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function corrupt(): LocalPersistenceError {
  return new LocalPersistenceError(
    "corrupt",
    "Stored local turn artifact is invalid",
  );
}
