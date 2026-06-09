import {
  ProtocolTimestampSchema,
  WorkerIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import {
  StableWorkerIdentifierSchema,
  WorkerOperationNameSchema,
} from "./common.js";

export const WorkerKindSchema = z.enum(["cloud", "local", "self_hosted"]);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

export const WorkerBackendKindSchema = z.enum([
  "cloud_sandbox",
  "local_cli",
  "local_desktop",
  "self_hosted",
]);
export type WorkerBackendKind = z.infer<typeof WorkerBackendKindSchema>;

export const WorkerIsolationStrengthSchema = z.enum([
  "none",
  "process",
  "container",
  "sandbox",
  "virtual_machine",
]);
export type WorkerIsolationStrength = z.infer<
  typeof WorkerIsolationStrengthSchema
>;

export const WorkerArtifactStoreKindSchema = z.enum([
  "r2",
  "local_blob",
  "worker_blob",
  "external_blob",
]);
export type WorkerArtifactStoreKind = z.infer<
  typeof WorkerArtifactStoreKindSchema
>;

export const WorkerCapabilitiesRequestSchema = z.object({}).strict();
export type WorkerCapabilitiesRequest = z.infer<
  typeof WorkerCapabilitiesRequestSchema
>;

export const WorkerCapabilitySnapshotSchema = z
  .object({
    workerId: WorkerIdSchema,
    workerKind: WorkerKindSchema,
    backendKind: WorkerBackendKindSchema,
    version: z.string().min(1).max(128),
    supportsShell: z.boolean(),
    supportsGit: z.boolean(),
    supportsSnapshots: z.boolean(),
    supportsBrowser: z.boolean(),
    supportsLongRunningProcesses: z.boolean(),
    supportsNetworkEgress: z.boolean(),
    maxRuntimeSeconds: z.number().int().safe().positive(),
    maxWorkspaceBytes: z.number().int().safe().positive(),
    isolationStrength: WorkerIsolationStrengthSchema,
    supportedLanguages: z
      .array(StableWorkerIdentifierSchema)
      .max(128)
      .refine(
        (languages) => new Set(languages).size === languages.length,
        "supported languages must be unique",
      ),
    artifactStoreKind: WorkerArtifactStoreKindSchema,
    supportedOperations: z
      .array(WorkerOperationNameSchema)
      .min(1)
      .max(64)
      .refine(
        (operations) => new Set(operations).size === operations.length,
        "supported operations must be unique",
      ),
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkerCapabilitySnapshot = z.infer<
  typeof WorkerCapabilitySnapshotSchema
>;
