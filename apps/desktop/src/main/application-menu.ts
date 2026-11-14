import { Menu, type MenuItemConstructorOptions } from "electron";

/** Native entry points dispatch intent; the renderer retains explicit grant confirmation. */
export function installDesktopApplicationMenu(onOpenFolder: () => void): void {
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
