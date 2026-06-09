import { z } from "zod";
import { ProtocolTimestampSchema } from "./common.js";
import {
  ModelIdSchema,
  ProviderIdSchema,
  WorkerIdSchema,
} from "./ids.js";

const StableCapabilityKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/);

const StableImplementationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/);

function hasUniqueCapabilityKeys(
  capabilities: readonly { key: string }[],
): boolean {
  return new Set(capabilities.map(({ key }) => key)).size === capabilities.length;
}

export const CapabilitySupportStateSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type CapabilitySupportState = z.infer<
  typeof CapabilitySupportStateSchema
>;

export const CapabilityEvidenceSourceSchema = z.enum([
  "static_registry",
  "provider_discovery",
  "runtime_probe",
  "policy_override",
]);
export type CapabilityEvidenceSource = z.infer<
  typeof CapabilityEvidenceSourceSchema
>;

export const CapabilityConfidenceSchema = z.enum([
  "authoritative",
  "reported",
  "inferred",
  "unknown",
]);
export type CapabilityConfidence = z.infer<
  typeof CapabilityConfidenceSchema
>;

export const CapabilityEntrySchema = z
  .object({
    key: StableCapabilityKeySchema,
    support: CapabilitySupportStateSchema,
    source: CapabilityEvidenceSourceSchema,
    confidence: CapabilityConfidenceSchema,
  })
  .strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

const CapabilityEntriesSchema = z
  .array(CapabilityEntrySchema)
  .max(256)
  .refine(hasUniqueCapabilityKeys, "capability keys must be unique");

export const ProviderCapabilitySnapshotSchema = z
  .object({
    providerId: ProviderIdSchema,
    capabilities: CapabilityEntriesSchema,
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type ProviderCapabilitySnapshot = z.infer<
  typeof ProviderCapabilitySnapshotSchema
>;

export const ModelCapabilitySnapshotSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    capabilities: CapabilityEntriesSchema,
    contextWindowTokens: z.number().int().safe().positive().nullable(),
    maxOutputTokens: z.number().int().safe().positive().nullable(),
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type ModelCapabilitySnapshot = z.infer<
  typeof ModelCapabilitySnapshotSchema
>;

export const WorkerExecutionLocationSchema = z.enum([
  "cloud_sandbox",
  "desktop_local",
  "local_worktree",
  "cloud_vm",
  "ssh_remote",
  "self_hosted_worker",
]);
export type WorkerExecutionLocation = z.infer<
  typeof WorkerExecutionLocationSchema
>;

export const WorkerIsolationStrengthSchema = z.enum([
  "process",
  "container",
  "sandbox",
  "virtual_machine",
]);
export type WorkerIsolationStrength = z.infer<
  typeof WorkerIsolationStrengthSchema
>;

export const WorkerCapabilitySnapshotSchema = z
  .object({
    workerId: WorkerIdSchema,
    workerKind: StableImplementationIdSchema,
    workerVersion: z.string().min(1).max(128),
    executionLocation: WorkerExecutionLocationSchema,
    supportsShell: z.boolean(),
    supportsGit: z.boolean(),
    supportsFileWrite: z.boolean(),
    supportsSnapshots: z.boolean(),
    supportsBrowser: z.boolean(),
    supportsNetworkEgress: z.boolean(),
    supportsLongRunningProcesses: z.boolean(),
    maxRuntimeSeconds: z.number().int().safe().positive(),
    maxWorkspaceBytes: z.number().int().safe().positive(),
    isolationStrength: WorkerIsolationStrengthSchema,
    supportedLanguages: z
      .array(StableImplementationIdSchema)
      .max(128)
      .refine(
        (languages) => new Set(languages).size === languages.length,
        "supported languages must be unique",
      ),
    artifactStoreKind: StableImplementationIdSchema,
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkerCapabilitySnapshot = z.infer<
  typeof WorkerCapabilitySnapshotSchema
>;
