import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";

import { BUILD_INFO_CHANNEL } from "../shared/desktop-api";
import { createWindowOptions } from "./window-options";

const preloadPath = fileURLToPath(
  new URL("../preload/index.cjs", import.meta.url),
);

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

void app.whenReady().then(createWindow);

app.on("window-all-closed", () => app.quit());
