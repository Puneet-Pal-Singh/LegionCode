import type {
  AppServerEnvironmentSnapshot,
  AppServerInitializeResponse,
} from "@repo/platform-protocol";

export const BUILD_INFO_CHANNEL = "desktop:get-build-info";
export const ENVIRONMENT_SNAPSHOT_CHANNEL = "desktop:get-environment";
export const ENVIRONMENT_STATUS_CHANNEL = "desktop:environment-status";
export const ENVIRONMENT_RESTART_CHANNEL = "desktop:restart-environment";

export type DesktopBuildInfo = {
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  packaged: boolean;
};

export type DesktopApi = {
  getBuildInfo(): Promise<DesktopBuildInfo>;
  getEnvironment(): Promise<DesktopEnvironmentConfig>;
  onEnvironmentStatus(
    listener: (snapshot: AppServerEnvironmentSnapshot) => void,
  ): () => void;
  restartEnvironment(): Promise<void>;
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
};

export type AppServerHandshakeResult = AppServerInitializeResponse;
