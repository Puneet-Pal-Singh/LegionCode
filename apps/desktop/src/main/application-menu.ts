import { Menu, type MenuItemConstructorOptions } from "electron";

/** Native entry points dispatch intent; the renderer retains explicit grant confirmation. */
export function installDesktopApplicationMenu(onOpenFolder: () => void, onSetupLocalExecution?: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => onOpenFolder(),
        },
        ...(onSetupLocalExecution ? [{
          label: "Set Up Local Execution…",
          click: () => onSetupLocalExecution(),
        }] : []),
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
