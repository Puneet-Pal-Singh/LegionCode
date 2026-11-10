import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderIdSchema,
  findBuiltinProvider,
  isLaunchSupportedProvider,
} from "@repo/shared-types";
import {
  AppServerResponseSchema,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";
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
} from "../shared/desktop-api";
import { createWindowOptions } from "./window-options";
import { installDesktopApplicationMenu } from "./application-menu";
import { LocalAppServerSupervisor } from "./local-app-server-supervisor";
import { DesktopCredentialVault } from "./desktop-credential-vault";
import {
  assertTrustedDesktopFrame as assertTrustedFrameFacts,
  resolveDesktopAppServerRequest,
  WorkspaceSelectionTokens,
} from "./request-security";

const preloadPath = fileURLToPath(
  new URL("../preload/index.cjs", import.meta.url),
);
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
let credentialVault: DesktopCredentialVault | null = null;
const localAppServer = new LocalAppServerSupervisor(
  (request) => providerRequestHeaders(request),
  async (providerId) => credentialVault?.acquireRuntimeCredentialLease(providerId) ?? null,
);
const pendingWorkspaceSelections = new WorkspaceSelectionTokens();
const expectedRendererUrls = new Map<number, string>();
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;
let environmentGeneration = 0;

app.on("second-instance", () => {
  if (!isPrimaryInstance || isQuitting || shutdownPromise) return;
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed(),
  );
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

async function providerRequestHeaders(
  request: AppServerRequest,
): Promise<Record<string, string>> {
  if (request.method !== "provider/select") return {};
  const providerId = ProviderIdSchema.parse(request.params.providerId);
  const vault = credentialVault;
  if (!vault) throw new Error("Protected provider credentials are unavailable");
  try {
    if (!(await vault.isConnected(providerId))) {
      throw new Error("Provider credential is missing");
    }
  } catch {
    throw new Error("Provider credential is missing or unavailable");
  }
  return {
    "x-legioncode-provider-configuration": JSON.stringify({
      providerId,
      status: "present",
    }),
  };
}

function assertTrustedDesktopFrame(event: Electron.IpcMainInvokeEvent): void {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const expectedRendererUrl = expectedRendererUrls.get(event.sender.id);
  assertTrustedFrameFacts({
    senderFrameRoutingId: event.senderFrame?.routingId,
    mainFrameRoutingId: browserWindow ? event.sender.mainFrame.routingId : undefined,
    senderFrameUrl: event.senderFrame?.url,
    expectedRendererUrl,
    hasDesktopWindow: browserWindow !== null && expectedRendererUrl !== undefined,
  });
}

function handleNativeInvoke<T>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedDesktopFrame(event);
    return handler(event, ...args);
  });
}

handleNativeInvoke(ENVIRONMENT_SNAPSHOT_CHANNEL, () =>
  localAppServer.getEnvironment(),
);
handleNativeInvoke(ENVIRONMENT_RESTART_CHANNEL, async () => {
  if (shutdownPromise || isQuitting) throw new Error("Local runtime shutdown is pending");
  environmentGeneration += 1;
  pendingWorkspaceSelections.clear();
  await localAppServer.restart(app.getVersion());
});
handleNativeInvoke(WORKSPACE_PICK_CHANNEL, async (event) => {
  const requestGeneration = environmentGeneration;
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Choose a local Git workspace",
  });
  assertTrustedDesktopFrame(event);
  if (requestGeneration !== environmentGeneration) {
    throw new Error("Workspace selection was interrupted");
  }
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  const selectionToken = randomBytes(32).toString("base64url");
  pendingWorkspaceSelections.issue(
    selectionToken,
    path,
    event.sender.id,
    Date.now() + 5 * 60 * 1_000,
  );
  return { selectionToken, displayName: basename(path) };
});
handleNativeInvoke(CREDENTIAL_COMMAND_CHANNEL, async (_event, value) => {
  const parsedCommand = DesktopCredentialCommandSchema.safeParse(value);
  if (!parsedCommand.success) throw new Error("Provider credential request was rejected");
  const command = parsedCommand.data;
  if (!credentialVault) throw new Error("Protected provider credentials are unavailable");
  if (command.operation === "save") {
    const request = command.request;
    const provider = findBuiltinProvider(request.providerId);
    if (!provider || !isLaunchSupportedProvider(provider) || !provider.authModes.includes("api_key")) {
      throw new Error("Provider is not available in this Desktop build");
    }
    await credentialVault.setCredential(request.providerId, request.apiKey, request.config);
    return { ok: true } as const;
  }
  if (command.operation === "delete" || command.operation === "status") {
    if (command.operation === "delete") {
      await credentialVault.deleteCredential(command.providerId);
      return { ok: true } as const;
    }
    return { providerId: command.providerId, status: await credentialVault.status(command.providerId) };
  }
  if (command.operation === "list" && Object.keys(command).length === 1) {
    const providerIds = await credentialVault.listConnectedProviders();
    return providerIds.map((providerId) => ({ providerId, status: "present" as const }));
  }
  throw new Error("Provider credential request was rejected");
});
handleNativeInvoke(APP_SERVER_REQUEST_CHANNEL, async (event, value) => {
  let request: AppServerRequest;
  try {
    request = resolveDesktopAppServerRequest(
      value,
      event.sender.id,
      pendingWorkspaceSelections,
    );
  } catch {
    throw new Error("Desktop App Server request was rejected");
  }

  try {
    const response = AppServerResponseSchema.parse(
      await localAppServer.request(request),
    );
    if (response.method !== request.method) {
      throw new Error("Response method did not match request");
    }
    return response;
  } catch {
    throw new Error("Local App Server request failed");
  }
});

function createWindow(): void {
  const window = new BrowserWindow(createWindowOptions(preloadPath));
  const webContents = window.webContents;
  const developmentUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  let rendererUrl: string;

  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      url.username ||
      url.password
    ) {
      throw new Error("Desktop development renderer must run on loopback");
    }
    rendererUrl = url.toString();
  } else {
    rendererUrl = new URL("../renderer/index.html", import.meta.url).toString();
  }

  expectedRendererUrls.set(webContents.id, rendererUrl);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== rendererUrl) event.preventDefault();
  });
  window.once("closed", () => {
    expectedRendererUrls.delete(webContents.id);
    pendingWorkspaceSelections.clearForSender(webContents.id);
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(rendererUrl);
}

handleNativeInvoke(BUILD_INFO_CHANNEL, () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
}));

void app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  credentialVault = new DesktopCredentialVault(app.getPath("userData"), {
    isEncryptionAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          safeStorage.getSelectedStorageBackend(),
        )),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  });
  const appData = realpathSync(app.getPath("appData"));
  let nativeWriterFenceDirectory: string | undefined;
  if (process.platform === "darwin") {
    try {
      const directory = join(appData, "LegionCode", "native-workspace-writers-v1");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const identity = lstatSync(directory);
      if (identity.isDirectory() && !identity.isSymbolicLink() &&
          (identity.mode & 0o777) === 0o700 && identity.uid === process.getuid?.() &&
          realpathSync(directory) === directory) nativeWriterFenceDirectory = directory;
    } catch { /* An unavailable host namespace leaves captured execution unconfigured. */ }
  }
  const protectedHostRoots = [
    appData,
    app.getPath("userData"), app.getAppPath(), process.resourcesPath,
    fileURLToPath(new URL(".", import.meta.url)),
  ].map((path) => realpathSync(path));
  const resolveHelper = (name: string): string | undefined => {
    const candidate = app.isPackaged
      ? join(process.resourcesPath, "native", name)
      : join(app.getAppPath(), "native-bin", name);
    try {
      const helperPath = realpathSync(candidate);
      if (statSync(helperPath).isFile()) return helperPath;
    } catch { /* Missing packaged helper keeps native queries unavailable. */ }
    return undefined;
  };
  const nativeFilesystemHelperPath = resolveHelper("legioncode-fs-helper");
  const nativeProcessHelperPath = resolveHelper("legioncode-process-helper");
  void localAppServer.start(app.getVersion(), app.getPath("userData"), {
    protectedHostRoots: [...new Set(protectedHostRoots)],
    nativeWriterFenceDirectory,
    nativeFilesystemHelperPath, nativeProcessHelperPath,
  });
  createWindow();
  installDesktopApplicationMenu(() => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const expectedRendererUrl = expectedRendererUrls.get(window.webContents.id);
    if (!expectedRendererUrl || window.webContents.getURL() !== expectedRendererUrl) return;
    window.webContents.send(WORKSPACE_OPEN_REQUESTED_CHANNEL);
  });
});

localAppServer.subscribe((snapshot) => {
  if (snapshot.status !== "ready") {
    environmentGeneration += 1;
    pendingWorkspaceSelections.clear();
  }
  for (const window of BrowserWindow.getAllWindows()) {
    const expectedUrl = expectedRendererUrls.get(window.webContents.id);
    if (expectedUrl && window.webContents.getURL() === expectedUrl) {
      window.webContents.send(ENVIRONMENT_STATUS_CHANNEL, snapshot);
    }
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  if (!shutdownPromise) {
    pendingWorkspaceSelections.clear();
    shutdownPromise = localAppServer.stop().then(() => {
      isQuitting = true;
      app.quit();
    }).catch(() => {
      shutdownPromise = null;
      dialog.showErrorBox(
        "Local runtime is still running",
        "LegionCode could not confirm that its local runtime stopped. Try quitting again.",
      );
    });
  }
});
app.on("window-all-closed", () => app.quit());
