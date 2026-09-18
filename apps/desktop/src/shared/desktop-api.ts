export const BUILD_INFO_CHANNEL = "desktop:get-build-info";

export type DesktopBuildInfo = {
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  packaged: boolean;
};

export type DesktopApi = {
  getBuildInfo(): Promise<DesktopBuildInfo>;
};
