import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import type { DesktopCommand } from "../shared/desktop-bridge";

export type MenuActions = {
  /** 菜单项 → 渲染层命令（与 use-global-shortcuts.ts 的键位语义一一对应） */
  sendCommand: (command: DesktopCommand) => void;
  showServerInfo: () => void;
  checkForUpdates: () => void;
  /** 开关打开时先交给原生 first responder，返回 false 时仍走网页编辑。 */
  ghosttyClipboard?: (paste: boolean) => boolean;
};

/**
 * 原生菜单（plan 103）。⌘T/⌘W/⌘N/⌘[ ]/⌘/ 这些由页面处理的键：菜单项展示键位但 **不注册**
 * accelerator（registerAccelerator: false）——键落到页面，由 use-global-shortcuts 按纯 ⌘
 * 前缀处理；点菜单项才走 sendCommand。关窗改成 ⇧⌘W，把 ⌘W 让给「关闭终端」。
 * 编辑菜单的 role 是剪贴板快捷键在 Electron/macOS 上生效的前提，不能省。
 */
export function buildAppMenu(actions: MenuActions): Menu {
  const pageShortcut = (label: string, accelerator: string, command: DesktopCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => actions.sendCommand(command),
  });

  const devItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ type: "separator" }, { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }];

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "检查更新…", click: () => actions.checkForUpdates() },
        { type: "separator" },
        { label: "服务器地址…", click: () => actions.showServerInfo() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "文件",
      submenu: [
        pageShortcut("新建工作区", "CmdOrCtrl+N", "create-workspace"),
        pageShortcut("新建终端", "CmdOrCtrl+T", "create-terminal"),
        pageShortcut("关闭终端", "CmdOrCtrl+W", "close-terminal"),
        { type: "separator" },
        { role: "close", label: "关闭窗口", accelerator: "Shift+CmdOrCtrl+W" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        actions.ghosttyClipboard ? {
          label: "复制", accelerator: "CmdOrCtrl+C", click: () => {
            if (!actions.ghosttyClipboard?.(false)) BrowserWindow.getFocusedWindow()?.webContents.copy();
          },
        } : { role: "copy" },
        actions.ghosttyClipboard ? {
          label: "粘贴", accelerator: "CmdOrCtrl+V", click: () => {
            if (!actions.ghosttyClipboard?.(true)) BrowserWindow.getFocusedWindow()?.webContents.paste();
          },
        } : { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        pageShortcut("上一个终端", "CmdOrCtrl+[", "previous-tab"),
        pageShortcut("下一个终端", "CmdOrCtrl+]", "next-tab"),
        ...devItems,
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      role: "window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
    {
      label: "帮助",
      role: "help",
      submenu: [pageShortcut("快捷键", "CmdOrCtrl+/", "toggle-help")],
    },
  ];

  return Menu.buildFromTemplate(template);
}
