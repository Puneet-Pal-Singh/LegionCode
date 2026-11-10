import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactIdSchema, EventIdSchema, EventSequenceSchema, ProtocolTimestampSchema } from "@repo/platform-protocol";
import { LocalTurnArtifactScopeSchema } from "./local-turn-artifact-scope.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import { EventStoreError, LocalPersistenceError } from "./errors.js";

export const LOCAL_NATIVE_SETTLEMENT_PREFIX = "turn_artifact_v1:native_settlement:";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const LocalNativeFileIdentitySchema = z.object({
  device: z.string().regex(/^[0-9a-f]{1,32}$/u),
  inode: z.string().regex(/^[0-9a-f]{1,32}$/u),
}).strict();
export type LocalNativeFileIdentity = z.infer<typeof LocalNativeFileIdentitySchema>;

export const LocalNativeReleasedFenceSchema = z.object({
  namespace: LocalNativeFileIdentitySchema,
  lease: LocalNativeFileIdentitySchema,
}).strict();
export type LocalNativeReleasedFence = z.infer<typeof LocalNativeReleasedFenceSchema>;

const artifactReference = z.object({
  role: z.enum(["start", "terminal", "diff"]),
  artifactId: ArtifactIdSchema,
  sha256: digest,
}).strict();

/** Private immutable closure evidence, not a lifecycle event or review artifact. */
export const LocalNativeResourceSettlementSchema = z.object({
  formatVersion: z.literal(1),
  scope: LocalTurnArtifactScopeSchema,
  admissionSha256: digest,
  terminal: z.object({ eventId: EventIdSchema, sequence: EventSequenceSchema, sha256: digest,
    status: z.enum(["completed", "failed", "interrupted"]),
  }).strict(),
  artifactCapture: z.enum(["required", "omitted_read_only"]),
  artifacts: z.array(artifactReference).max(3)
    .refine((references) => new Set(references.map((reference) => reference.role)).size === references.length),
  root: LocalNativeFileIdentitySchema,
  gitMetadataIdentity: z.string().min(1).max(512),
  grantedAt: ProtocolTimestampSchema,
  generation: z.number().int().safe().nonnegative(),
  writerFence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("released"), identity: LocalNativeReleasedFenceSchema }).strict(),
    z.object({ kind: z.literal("not_acquired") }).strict(),
    z.object({ kind: z.literal("read_only") }).strict(),
  ]),
}).strict().refine((record) => record.artifactCapture === "required"
  ? record.writerFence.kind !== "read_only"
  : record.writerFence.kind === "read_only", "Native capture and writer disposition must agree");
export type LocalNativeResourceSettlement = z.infer<typeof LocalNativeResourceSettlementSchema>;

type Guard = <T>(operation: () => T) => T;
export function createLocalNativeSettlementAccess(database: Database.Database, guard: Guard,
  input: z.infer<typeof LocalTurnArtifactScopeSchema>) {
  const scope = LocalTurnArtifactScopeSchema.parse(input);
  const key = storageKey(scope);
  const read = (): LocalNativeResourceSettlement | null => {
    const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    return validateLocalNativeSettlementRecord(key, row.value);
  };
  return {
    async getNativeResourceSettlement(): Promise<LocalNativeResourceSettlement | null> {
      return guard(read);
    },
    async putNativeResourceSettlement(input: LocalNativeResourceSettlement): Promise<LocalNativeResourceSettlement> {
      const record = LocalNativeResourceSettlementSchema.parse(input);
      if (encode(record.scope) !== encode(scope)) throw new Error("Native settlement belongs to another attempt");
      return guard(() => database.transaction(() => {
        const existing = read();
        if (existing) {
          if (encode(existing) !== encode(record)) throw new EventStoreError("idempotency_conflict", "Native settlement already contains different immutable evidence");
          return existing;
        }
        database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run(key, encode(record));
        return record;
      }).immediate());
    },
  };
}

export function validateLocalNativeSettlementRecord(key: string, value: string): LocalNativeResourceSettlement {
  try {
    const record = LocalNativeResourceSettlementSchema.parse(JSON.parse(value));
    if (key !== storageKey(record.scope)) throw new Error("Native settlement scope mismatch");
    return record;
  } catch {
    throw new LocalPersistenceError("corrupt", "Stored Native resource settlement is invalid");
  }
}

function storageKey(scope: z.infer<typeof LocalTurnArtifactScopeSchema>): string {
  return `${LOCAL_NATIVE_SETTLEMENT_PREFIX}${createHash("sha256").update(encode(scope)).digest("hex")}`;
}
function encode(value: unknown): string { return createStableEventFingerprint(value); }
