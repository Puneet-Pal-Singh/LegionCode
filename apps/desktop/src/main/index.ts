import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_INFO_CHANNEL,
  ENVIRONMENT_SNAPSHOT_CHANNEL,
  ENVIRONMENT_STATUS_CHANNEL,
  ENVIRONMENT_RESTART_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
  WORKSPACE_GRANT_CHANNEL,
  WORKSPACE_CURRENT_CHANNEL,
  WORKSPACE_REVOKE_CHANNEL,
} from "../shared/desktop-api";
import { createWindowOptions } from "./window-options";
import { LocalAppServerSupervisor } from "./local-app-server-supervisor";

const preloadPath = fileURLToPath(
  new URL("../preload/index.cjs", import.meta.url),
);
const localAppServer = new LocalAppServerSupervisor();
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;
const pendingWorkspaceSelections = new Map<
  string,
  { path: string; expiresAt: number }
>();

function assertTrustedDesktopFrame(event: Electron.IpcMainInvokeEvent): void {
  if (event.senderFrame?.routingId !== event.sender.mainFrame.routingId) {
    throw new Error("Desktop environment access requires the main frame");
  }
  if (!BrowserWindow.fromWebContents(event.sender)) {
    throw new Error("Desktop environment access requires a Desktop window");
  }
}

ipcMain.handle(ENVIRONMENT_SNAPSHOT_CHANNEL, (event) => {
  assertTrustedDesktopFrame(event);
  return localAppServer.getEnvironment();
});
ipcMain.handle(ENVIRONMENT_RESTART_CHANNEL, async (event) => {
  assertTrustedDesktopFrame(event);
  await localAppServer.restart(app.getVersion());
});
ipcMain.handle(WORKSPACE_PICK_CHANNEL, async (event) => {
  assertTrustedDesktopFrame(event);
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Choose a local Git workspace",
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) {
    return null;
  }
  const selectionToken = randomBytes(32).toString("base64url");
  pendingWorkspaceSelections.set(selectionToken, {
    path,
    expiresAt: Date.now() + 5 * 60 * 1_000,
  });
  return { selectionToken, displayName: basename(path) };
});
ipcMain.handle(WORKSPACE_GRANT_CHANNEL, async (event, token: unknown) => {
  assertTrustedDesktopFrame(event);
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Workspace selection token is invalid");
  }
  const selection = pendingWorkspaceSelections.get(token);
  pendingWorkspaceSelections.delete(token);
  if (!selection || selection.expiresAt < Date.now()) {
    throw new Error("Workspace selection token is expired or already used");
  }
  return await localAppServer.grantWorkspace(selection.path);
});
ipcMain.handle(WORKSPACE_CURRENT_CHANNEL, (event) => {
  assertTrustedDesktopFrame(event);
  return localAppServer.getWorkspaceGrant();
});
ipcMain.handle(WORKSPACE_REVOKE_CHANNEL, async (event) => {
  assertTrustedDesktopFrame(event);
  await localAppServer.revokeWorkspace();
});

function createWindow(): void {
  const window = new BrowserWindow(createWindowOptions(preloadPath));
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  let rendererUrl: string;

  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("Desktop development renderer must run on loopback");
    }
    rendererUrl = url.toString();
  } else {
    rendererUrl = new URL("../renderer/index.html", import.meta.url).toString();
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== rendererUrl) {
      event.preventDefault();
    }
  });
  window.once("ready-to-show", () => window.show());

  void window.loadURL(rendererUrl);
}

ipcMain.handle(BUILD_INFO_CHANNEL, () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
}));

void app.whenReady().then(() => {
  void localAppServer.start(app.getVersion(), app.getPath("userData"));
  createWindow();
});

localAppServer.subscribe((snapshot) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(ENVIRONMENT_STATUS_CHANNEL, snapshot);
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  if (!shutdownPromise) {
    shutdownPromise = localAppServer.stop().finally(() => {
      isQuitting = true;
      app.quit();
    });
  }
});
app.on("window-all-closed", () => app.quit());
