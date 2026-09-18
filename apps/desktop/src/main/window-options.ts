import type { BrowserWindowConstructorOptions } from "electron";

export function createWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
