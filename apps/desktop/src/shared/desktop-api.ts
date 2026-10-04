import { z } from "zod";
import { BYOKConnectRequestSchema, ProviderIdSchema } from "@repo/shared-types";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";

export const APP_SERVER_REQUEST_CHANNEL = "desktop:app-server-request";
export const BUILD_INFO_CHANNEL = "desktop:get-build-info";
export const ENVIRONMENT_SNAPSHOT_CHANNEL = "desktop:get-environment";
export const ENVIRONMENT_STATUS_CHANNEL = "desktop:environment-status";
export const ENVIRONMENT_RESTART_CHANNEL = "desktop:restart-environment";
export const WORKSPACE_PICK_CHANNEL = "desktop:pick-workspace";
export const CREDENTIAL_COMMAND_CHANNEL = "desktop:credential-command";

export const DesktopCredentialStatusSchema = z.object({
  providerId: ProviderIdSchema,
  status: z.enum(["present", "missing", "unavailable"]),
}).strict();

export const DesktopCredentialCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("save"), request: BYOKConnectRequestSchema }).strict(),
  z.object({ operation: z.literal("delete"), providerId: ProviderIdSchema }).strict(),
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("status"), providerId: ProviderIdSchema }).strict(),
]);

export const DesktopCredentialResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  DesktopCredentialStatusSchema,
  z.array(DesktopCredentialStatusSchema),
]);

export type DesktopCredentialStatus = z.infer<typeof DesktopCredentialStatusSchema>;

export type DesktopCredentialCommand = z.infer<typeof DesktopCredentialCommandSchema>;
export type DesktopCredentialResult = z.infer<typeof DesktopCredentialResultSchema>;

export type DesktopBuildInfo = {
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  packaged: boolean;
};

export type WorkspaceSelection = {
  selectionToken: string;
  displayName: string;
};

export type DesktopApi = {
  request(envelope: AppServerRequest): Promise<unknown>;
  getBuildInfo(): Promise<DesktopBuildInfo>;
  getEnvironment(): Promise<AppServerEnvironmentSnapshot>;
  onEnvironmentStatus(
    listener: (snapshot: AppServerEnvironmentSnapshot) => void,
  ): () => void;
  restartEnvironment(): Promise<void>;
  pickWorkspace(): Promise<WorkspaceSelection | null>;
  credential(command: DesktopCredentialCommand): Promise<DesktopCredentialResult>;
};

export type DesktopEnvironmentConfig = AppServerEnvironmentSnapshot;

export type DesktopEnvironmentConnection = {
  baseUrl: string;
  credential: string;
};

export type LocalAppServerReadyMessage = {
  type: "ready";
  baseUrl: string;
};

export type LocalAppServerFatalMessage = {
  type: "fatal";
};

export type LocalAppServerMessage =
  | LocalAppServerReadyMessage
  | LocalAppServerFatalMessage;

export type LocalAppServerStartMessage = {
  type: "start";
  credential: string;
  serverVersion: string;
  storageDirectory: string;
};
