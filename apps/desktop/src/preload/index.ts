import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

import {
  AppServerRequestSchema,
  AppServerResponseSchema,
} from "@legioncode/app-server/protocol";
import {
  AppServerEnvironmentSnapshotSchema,
} from "@repo/platform-protocol";
import {
  APP_SERVER_REQUEST_CHANNEL,
  BUILD_INFO_CHANNEL,
  ENVIRONMENT_SNAPSHOT_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_RESTART_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
  type DesktopApi,
  type DesktopBuildInfo,
} from "../shared/desktop-api";

const WorkspaceSelectionSchema = z
  .object({
    selectionToken: z.string().min(32).max(512),
    displayName: z.string().min(1).max(255),
  })
  .strict();
const BuildInfoSchema = z
  .object({
    version: z.string().min(1).max(120),
    platform: z.enum([
      "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32",
    ]),
    arch: z.enum([
      "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64",
    ]),
    packaged: z.boolean(),
  })
  .strict();

const desktopApi: DesktopApi = {
  request: async (envelope) => {
    const request = AppServerRequestSchema.parse(envelope);
    const response = AppServerResponseSchema.parse(
      await ipcRenderer.invoke(APP_SERVER_REQUEST_CHANNEL, request),
    );
    if (response.method !== request.method) {
      throw new Error("Desktop App Server response did not match its request");
    }
    return response;
  },
  getBuildInfo: async () => BuildInfoSchema.parse(
    await ipcRenderer.invoke(BUILD_INFO_CHANNEL),
  ) satisfies DesktopBuildInfo,
  getEnvironment: async () =>
    AppServerEnvironmentSnapshotSchema.parse(
      await ipcRenderer.invoke(ENVIRONMENT_SNAPSHOT_CHANNEL),
    ),
  onEnvironmentStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
      const parsed = AppServerEnvironmentSnapshotSchema.safeParse(snapshot);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(ENVIRONMENT_STATUS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ENVIRONMENT_STATUS_CHANNEL, handler);
  },
  restartEnvironment: async () => {
    await ipcRenderer.invoke(ENVIRONMENT_RESTART_CHANNEL);
  },
  pickWorkspace: async () => {
    const selection: unknown = await ipcRenderer.invoke(WORKSPACE_PICK_CHANNEL);
    return selection === null ? null : WorkspaceSelectionSchema.parse(selection);
  },
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(desktopApi));
