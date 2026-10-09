import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

import {
  AppServerRequestSchema,
  AppServerResponseSchema,
} from "@legioncode/app-server/protocol";
import {
  AppServerEnvironmentSnapshotSchema,
  APP_SERVER_PROTOCOL_VERSION,
} from "@repo/platform-protocol";
import {
  APP_SERVER_REQUEST_CHANNEL,
  BUILD_INFO_CHANNEL,
  ENVIRONMENT_SNAPSHOT_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_RESTART_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
  CREDENTIAL_COMMAND_CHANNEL,
  TURN_CONTINUATION_CHANNEL,
  DesktopContinuationRequestSchema,
  DesktopContinuationEventSchema,
  DesktopCredentialCommandSchema,
  DesktopCredentialResultSchema,
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
  subscribeContinuation: async (request, listener) => {
    const subscriptionId = crypto.randomUUID();
    const subscribe = DesktopContinuationRequestSchema.parse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      operation: "subscribe",
      subscriptionId,
      request,
    });
    let closed = false;
    let registered = false;
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = DesktopContinuationEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.subscriptionId !== subscriptionId) return;
      listener(parsed.data);
      if (parsed.data.operation === "failed") close();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      ipcRenderer.removeListener(TURN_CONTINUATION_CHANNEL, handler);
      if (registered) {
        void ipcRenderer.invoke(TURN_CONTINUATION_CHANNEL, DesktopContinuationRequestSchema.parse({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          operation: "unsubscribe",
          subscriptionId,
        })).catch(() => undefined);
      }
    };
    if (typeof listener !== "function") throw new Error("Desktop continuation listener is invalid");
    ipcRenderer.on(TURN_CONTINUATION_CHANNEL, handler);
    try {
      await ipcRenderer.invoke(TURN_CONTINUATION_CHANNEL, subscribe);
      registered = true;
      if (closed) {
        void ipcRenderer.invoke(TURN_CONTINUATION_CHANNEL, DesktopContinuationRequestSchema.parse({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          operation: "unsubscribe",
          subscriptionId,
        })).catch(() => undefined);
      }
      return close;
    } catch {
      close();
      throw new Error("Desktop Turn continuation could not start");
    }
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
  credential: async (command) => {
    const parsedCommand = DesktopCredentialCommandSchema.parse(command);
    const result: unknown = await ipcRenderer.invoke(CREDENTIAL_COMMAND_CHANNEL, parsedCommand);
    return DesktopCredentialResultSchema.parse(result);
  },
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(desktopApi));
