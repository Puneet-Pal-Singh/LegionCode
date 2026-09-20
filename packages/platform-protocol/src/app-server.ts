import { z } from "zod";

export const APP_SERVER_PROTOCOL_VERSION = "1.0.0" as const;

export const AppServerCapabilitySchema = z.string().min(1).max(120);
export type AppServerCapability = z.infer<typeof AppServerCapabilitySchema>;

export const AppServerUnavailableCapabilitySchema = z
  .object({
    capability: AppServerCapabilitySchema,
    reason: z.string().min(1).max(500),
  })
  .strict();
export type AppServerUnavailableCapability = z.infer<
  typeof AppServerUnavailableCapabilitySchema
>;

export const AppServerInitializeRequestSchema = z
  .object({
    protocolVersion: z.string().min(1).max(40),
    client: z
      .object({
        id: z.string().min(1).max(120),
        version: z.string().min(1).max(120),
      })
      .strict(),
    requestedCapabilities: z.array(AppServerCapabilitySchema).max(100),
  })
  .strict();
export type AppServerInitializeRequest = z.infer<
  typeof AppServerInitializeRequestSchema
>;

export const AppServerInitializeResponseSchema = z
  .object({
    protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
    server: z
      .object({
        id: z.string().min(1).max(120),
        version: z.string().min(1).max(120),
      })
      .strict(),
    environment: z.enum(["local", "hosted"]),
    capabilities: z.array(AppServerCapabilitySchema).max(100),
    unavailableCapabilities: z
      .array(AppServerUnavailableCapabilitySchema)
      .max(100),
  })
  .strict();
export type AppServerInitializeResponse = z.infer<
  typeof AppServerInitializeResponseSchema
>;

export const AppServerErrorSchema = z
  .object({
    code: z.enum(["unauthorized", "protocol_incompatible", "invalid_request"]),
    message: z.string().min(1).max(500),
  })
  .strict();
export type AppServerError = z.infer<typeof AppServerErrorSchema>;

export const AppServerConnectionStatusSchema = z.enum([
  "starting",
  "ready",
  "degraded",
  "offline",
  "stopped",
]);
export type AppServerConnectionStatus = z.infer<
  typeof AppServerConnectionStatusSchema
>;

export const AppServerEnvironmentSnapshotSchema = z
  .object({
    kind: z.enum(["local", "hosted"]),
    status: AppServerConnectionStatusSchema,
    protocolVersion: z.string().min(1).max(40).nullable(),
    serverVersion: z.string().min(1).max(120).nullable(),
    capabilities: z.array(AppServerCapabilitySchema).max(100),
    unavailableCapabilities: z
      .array(AppServerUnavailableCapabilitySchema)
      .max(100),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type AppServerEnvironmentSnapshot = z.infer<
  typeof AppServerEnvironmentSnapshotSchema
>;

export const LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES = [
  "thread-management-v1",
  "turn-execution-v1",
  "artifact-review-v1",
] as const;

export const LOCAL_APP_SERVER_CAPABILITIES = ["workspace-selection-v1"] as const;
