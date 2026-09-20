import { contextBridge, ipcRenderer } from "electron";

import {
  BUILD_INFO_CHANNEL,
  ENVIRONMENT_SNAPSHOT_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_RESTART_CHANNEL,
  type DesktopApi,
  type DesktopBuildInfo,
  type DesktopEnvironmentConfig,
} from "../shared/desktop-api";
import {
  AppServerEnvironmentSnapshotSchema,
  type AppServerEnvironmentSnapshot,
} from "@repo/platform-protocol";

const desktopApi: DesktopApi = Object.freeze({
  getBuildInfo: () =>
    ipcRenderer.invoke(BUILD_INFO_CHANNEL) as Promise<DesktopBuildInfo>,
  getEnvironment: () =>
    ipcRenderer.invoke(
      ENVIRONMENT_SNAPSHOT_CHANNEL,
    ) as Promise<DesktopEnvironmentConfig>,
  onEnvironmentStatus: (
    listener: (snapshot: AppServerEnvironmentSnapshot) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
      const parsed = AppServerEnvironmentSnapshotSchema.safeParse(snapshot);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(ENVIRONMENT_STATUS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ENVIRONMENT_STATUS_CHANNEL, handler);
  },
  restartEnvironment: () =>
    ipcRenderer.invoke(ENVIRONMENT_RESTART_CHANNEL) as Promise<void>,
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
