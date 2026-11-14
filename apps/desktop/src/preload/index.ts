import { contextBridge, ipcRenderer } from "electron";
import { HOSTED_ACCOUNT_CHANNEL, HostedAccountCommandSchema, HostedAccountSnapshotSchema } from "../shared/hosted-account";
import {
  HOSTED_REQUEST_CHANNEL, HOSTED_RESPONSE_CHANNEL, HostedRequestSchema,
  HostedRequestResultSchema, HostedResponseEventSchema, parseHostedEnvelope, sameHostedScope,
  type HostedResponseMetadata,
} from "../shared/hosted-request";
import { z } from "zod";

import {
  AppServerRequestSchema,
  assertLocalAppServerRequestBudget,
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
  WORKSPACE_OPEN_REQUESTED_CHANNEL,
  CREDENTIAL_COMMAND_CHANNEL,
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
  hostedAccount: async (command) => HostedAccountSnapshotSchema.parse(
    await ipcRenderer.invoke(HOSTED_ACCOUNT_CHANNEL, HostedAccountCommandSchema.parse(command)),
  ),
  hostedRequest: async (value, onResponse) => {
    const input = HostedRequestSchema.parse(value);
    parseHostedEnvelope(input.serializedEnvelope);
    let observed = false;
    let callbackFailed = false;
    const observe = (metadata: HostedResponseMetadata) => {
      if (observed) return;
      observed = true;
      try { onResponse?.(metadata); } catch { callbackFailed = true; }
    };
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = HostedResponseEventSchema.safeParse(value);
      if (parsed.success && parsed.data.requestId === input.requestId && sameHostedScope(parsed.data.scope, input.scope)) {
        observe(parsed.data.metadata);
      }
    };
    ipcRenderer.on(HOSTED_RESPONSE_CHANNEL, listener);
    try {
      // Await the original invocation even if a response observer throws.
      const result = HostedRequestResultSchema.parse(await ipcRenderer.invoke(HOSTED_REQUEST_CHANNEL, input));
      if (result.requestId !== input.requestId || !sameHostedScope(result.scope, input.scope)) {
        throw new Error("Hosted response scope changed");
      }
      if (result.metadata) observe(result.metadata);
      if (callbackFailed) throw new Error("Hosted response observer failed");
      return result;
    } finally {
      ipcRenderer.removeListener(HOSTED_RESPONSE_CHANNEL, listener);
    }
  },
  request: async (envelope) => {
    const request = AppServerRequestSchema.parse(envelope);
    assertLocalAppServerRequestBudget(request);
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
  onOpenWorkspaceRequested: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(WORKSPACE_OPEN_REQUESTED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WORKSPACE_OPEN_REQUESTED_CHANNEL, handler);
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
