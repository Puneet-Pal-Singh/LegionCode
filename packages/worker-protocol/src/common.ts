import { z } from "zod";

export const WORKER_PROTOCOL_VERSION = "2026-06-01";

export const WorkerProtocolVersionSchema = z.literal(WORKER_PROTOCOL_VERSION);
export type WorkerProtocolVersion = z.infer<
  typeof WorkerProtocolVersionSchema
>;

export const WORKER_OPERATION_NAMES = [
  "worker.capabilities",
  "command.run",
  "file.read",
  "file.write",
  "patch.apply",
  "git.status",
  "git.diff",
  "git.stage",
  "git.commit",
  "git.push",
  "artifact.upload",
  "artifact.download",
  "artifact.list",
] as const;

export const WorkerOperationNameSchema = z.enum(WORKER_OPERATION_NAMES);
export type WorkerOperationName = z.infer<
  typeof WorkerOperationNameSchema
>;

export const WorkerRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export type WorkerRequestId = z.infer<typeof WorkerRequestIdSchema>;

export const StableWorkerIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/);
export type StableWorkerIdentifier = z.infer<
  typeof StableWorkerIdentifierSchema
>;

export const DurationMsSchema = z.number().int().safe().nonnegative();
export type DurationMs = z.infer<typeof DurationMsSchema>;

export const TimeoutMsSchema = z.number().int().safe().positive();
export type TimeoutMs = z.infer<typeof TimeoutMsSchema>;

export const ByteCountSchema = z.number().int().safe().nonnegative();
export type ByteCount = z.infer<typeof ByteCountSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isWorkspaceRelativePath, "path must stay inside the workspace");
export type WorkspaceRelativePath = z.infer<
  typeof WorkspaceRelativePathSchema
>;

export const WorkerEnvironmentSchema = z.record(
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(10_000),
);
export type WorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema>;

function isWorkspaceRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\0")) {
    return false;
  }

  return path.split(/[\\/]/u).every(isSafePathSegment);
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}
