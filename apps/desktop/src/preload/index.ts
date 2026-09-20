import { contextBridge, ipcRenderer } from "electron";

import {
  BUILD_INFO_CHANNEL,
  ENVIRONMENT_SNAPSHOT_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_RESTART_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
  WORKSPACE_GRANT_CHANNEL,
  WORKSPACE_CURRENT_CHANNEL,
  WORKSPACE_REVOKE_CHANNEL,
  THREADS_LIST_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_RENAME_CHANNEL,
  THREAD_ARCHIVE_CHANNEL,
  THREAD_UNARCHIVE_CHANNEL,
  type DesktopApi,
  type DesktopBuildInfo,
  type DesktopEnvironmentConfig,
  type WorkspaceSelection,
} from "../shared/desktop-api";
import {
  AppServerEnvironmentSnapshotSchema,
  ThreadIdSchema,
  ThreadSchema,
  type AppServerEnvironmentSnapshot,
  type LocalWorkspaceGrant,
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
  pickWorkspace: () =>
    ipcRenderer.invoke(WORKSPACE_PICK_CHANNEL) as Promise<WorkspaceSelection | null>,
  grantWorkspace: (selectionToken: string) =>
    ipcRenderer.invoke(WORKSPACE_GRANT_CHANNEL, selectionToken) as Promise<LocalWorkspaceGrant>,
  getWorkspace: () =>
    ipcRenderer.invoke(WORKSPACE_CURRENT_CHANNEL) as Promise<LocalWorkspaceGrant | null>,
  revokeWorkspace: () =>
    ipcRenderer.invoke(WORKSPACE_REVOKE_CHANNEL) as Promise<void>,
  listThreads: async () =>
    ThreadSchema.array().parse(await ipcRenderer.invoke(THREADS_LIST_CHANNEL)),
  createThread: async (title) =>
    ThreadSchema.parse(await ipcRenderer.invoke(THREAD_CREATE_CHANNEL, title)),
  getThread: async (threadId) =>
    ThreadSchema.parse(
      await ipcRenderer.invoke(THREAD_GET_CHANNEL, ThreadIdSchema.parse(threadId)),
    ),
  renameThread: async (threadId, title) =>
    ThreadSchema.parse(
      await ipcRenderer.invoke(
        THREAD_RENAME_CHANNEL,
        ThreadIdSchema.parse(threadId),
        title,
      ),
    ),
  archiveThread: async (threadId) =>
    ThreadSchema.parse(
      await ipcRenderer.invoke(THREAD_ARCHIVE_CHANNEL, ThreadIdSchema.parse(threadId)),
    ),
  unarchiveThread: async (threadId) =>
    ThreadSchema.parse(
      await ipcRenderer.invoke(THREAD_UNARCHIVE_CHANNEL, ThreadIdSchema.parse(threadId)),
    ),
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
