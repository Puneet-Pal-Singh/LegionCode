import {
  JsonRecordSchema,
  ModelIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkerExecutionLocationSchema,
  WorkspaceIdSchema,
  WorkspaceManifestIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";

const BackendIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/);

export const HookPermissionModeSchema = z.enum([
  "auto",
  "ask",
  "read_only",
  "deny",
]);
export type HookPermissionMode = z.infer<typeof HookPermissionModeSchema>;

export const ModelContextAdditionSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(20_000),
    priority: z.enum(["low", "normal", "high"]),
    metadata: JsonRecordSchema,
  })
  .strict();
export type ModelContextAddition = z.infer<typeof ModelContextAdditionSchema>;

export const HookRuntimeContextSchema = z
  .object({
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
    turnId: TurnIdSchema.nullable(),
    workspaceId: WorkspaceIdSchema,
    workspaceRoot: z.string().min(1).max(2_048),
    executionLocation: WorkerExecutionLocationSchema,
    backendId: BackendIdSchema,
    modelId: ModelIdSchema,
    providerId: ProviderIdSchema,
    permissionMode: HookPermissionModeSchema,
    capabilityManifestId: WorkspaceManifestIdSchema,
    transcriptRef: z.string().min(1).max(2_048).nullable(),
  })
  .strict();
export type HookRuntimeContext = z.infer<typeof HookRuntimeContextSchema>;
