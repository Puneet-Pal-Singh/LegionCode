import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
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
  CREDENTIAL_COMMAND_CHANNEL,
  DesktopCredentialCommandSchema,
} from "../shared/desktop-api";
import { createWindowOptions } from "./window-options";
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
const localAppServer = new LocalAppServerSupervisor((request) =>
  providerRequestHeaders(request),
);
const pendingWorkspaceSelections = new WorkspaceSelectionTokens();
const expectedRendererUrls = new Map<number, string>();
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;
let environmentGeneration = 0;

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
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
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
  void localAppServer.start(app.getVersion(), app.getPath("userData"));
  createWindow();
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
    shutdownPromise = localAppServer.stop().finally(() => {
      isQuitting = true;
      app.quit();
    });
  }
});
app.on("window-all-closed", () => app.quit());
