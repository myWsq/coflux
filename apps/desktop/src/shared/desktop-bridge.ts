/**
 * 桌面桥接的类型真相源（plan 106）：preload 经 contextBridge 把实现挂到 `window.cofluxDesktop`，
 * 渲染层假定它必定存在（缺失即启动期报错，见 renderer/desktop-bridge.ts）。主进程 / preload / 渲染层
 * 三方都只从这里 type-import；文件里只有类型，不带任何运行时代码。
 *
 * 桥接面刻意最小：服务器地址 / 自报 Origin / 通知 / Dock 角标 / 「聚焦工作区」回调 / 原生菜单命令 /
 * 更新提示。不暴露 Node、fs、shell 之类通用能力。
 */

export type DesktopUpdateStatus = "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  /** 已发现/已下载的新版本号（available / downloading / downloaded 时有值） */
  version?: string;
  /** 下载进度 0-100（downloading 时有值） */
  percent?: number;
  /** 检查/下载失败的原因（error 时有值） */
  message?: string;
};

/** 原生菜单项触发的命令；语义与 use-global-shortcuts.ts 的键位一一对应，⌘1-9 不进菜单。 */
export type DesktopCommand = "create-terminal" | "close-terminal" | "create-workspace" | "previous-tab" | "next-tab" | "toggle-help";

export type DesktopNotification = {
  /** 点击通知后主进程回传给渲染层的工作区 id，用于选中该工作区 */
  workspaceId: string;
  title: string;
  body: string;
};

export type DesktopBridge = {
  readonly platform: string;
  /** app 版本（package.json version），与渲染层的 BUILD_ID 是两个维度 */
  readonly version: string;
  /** /client WS 端点；自定义 scheme 下没有可用的 location.host，地址只能来自 app 侧配置 */
  readonly serverUrl: string;
  /** 主进程在 WebSocket 握手上改写的稳定 https Origin；渲染层经 deviceTransport.origin 上报同值 */
  readonly origin: string;
  notify(notification: DesktopNotification): void;
  /** 待处理工作区数；0 清除角标 */
  setBadge(count: number): void;
  onFocusWorkspace(listener: (workspaceId: string) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  checkForUpdates(): void;
  installUpdate(): void;
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
};
