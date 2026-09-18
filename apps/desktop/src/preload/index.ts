import { contextBridge, ipcRenderer } from "electron";

import {
  BUILD_INFO_CHANNEL,
  type DesktopApi,
  type DesktopBuildInfo,
} from "../shared/desktop-api";

const desktopApi: DesktopApi = Object.freeze({
  getBuildInfo: () =>
    ipcRenderer.invoke(BUILD_INFO_CHANNEL) as Promise<DesktopBuildInfo>,
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
