import { app, Menu, type MenuItemConstructorOptions } from "electron";

import type { DesktopCommand } from "../shared/desktop-bridge";

export type MenuActions = {
  /** 菜单项 → 渲染层命令（与 use-global-shortcuts.ts 的键位语义一一对应） */
  sendCommand: (command: DesktopCommand) => void;
  checkForUpdates: () => void;
};

/**
 * 原生菜单（plan 103）。⌘T/⌘W/⌘N/⌘[ ]/⌘/ 这些由页面处理的键：菜单项展示键位但 **不注册**
 * accelerator（registerAccelerator: false）——键落到页面，由 use-global-shortcuts 按纯 ⌘
 * 前缀处理；点菜单项才走 sendCommand。关窗改成 ⇧⌘W，把 ⌘W 让给「关闭终端」。
 * ⌘R「重新载入」是唯一的例外：它是 webContents 层的动作，页面没有什么可代劳的，直接用原生 role。
 * 编辑菜单的 role 是剪贴板快捷键在 Electron/macOS 上生效的前提，不能省。
 */
export function buildAppMenu(actions: MenuActions): Menu {
  const pageShortcut = (label: string, accelerator: string, command: DesktopCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => actions.sendCommand(command),
  });

  // 「重新载入」已经是常驻项（见下面的「视图」），dev 构建只额外补强制重载与 devtools：
  // 这里再放一个 reload，dev 里就会出现两个同键位的「重新载入」。分隔符也归常驻项那边统一给，
  // 免得打包版少一条、dev 版多一条。
  const devItems: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ role: "forceReload" }, { role: "toggleDevTools" }];

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "检查更新…", click: () => actions.checkForUpdates() },
        { type: "separator" },
        pageShortcut("设置…", "CmdOrCtrl+,", "open-settings"),
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
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        // Navigation palette (plan 20260921): the accelerator is displayed but not registered
        // either, so the key itself reaches the page and use-global-shortcuts handles it.
        pageShortcut("快速跳转…", "CmdOrCtrl+P", "toggle-palette"),
        { type: "separator" },
        pageShortcut("上一个终端", "CmdOrCtrl+[", "previous-tab"),
        pageShortcut("下一个终端", "CmdOrCtrl+]", "next-tab"),
        { type: "separator" },
        // Editor groups (plan 20260923-terminal-split-groups): displayed, not registered, like the rest.
        // Unlike the tab context menu's 移到右侧/下方新分组 (which move that tab), these open a new terminal.
        // ⌘\ is also handled by the page, like the other page shortcuts above.
        pageShortcut("向右拆分（新建终端）", "CmdOrCtrl+\\", "split-right"),
        pageShortcut("向下拆分（新建终端）", "Shift+CmdOrCtrl+\\", "split-down"),
        pageShortcut("聚焦左侧分组", "Alt+CmdOrCtrl+Left", "focus-group-left"),
        pageShortcut("聚焦右侧分组", "Alt+CmdOrCtrl+Right", "focus-group-right"),
        pageShortcut("聚焦上方分组", "Alt+CmdOrCtrl+Up", "focus-group-up"),
        pageShortcut("聚焦下方分组", "Alt+CmdOrCtrl+Down", "focus-group-down"),
        { type: "separator" },
        // 打包版也有 ⌘R：界面卡住时不必退出应用（退出会连带断掉中心连接与本机 device 通道）。
        // role 自带 accelerator 与可用态；主进程注册的 accelerator 优先于页面，终端抢不走它。
        { role: "reload", label: "重新载入" },
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
