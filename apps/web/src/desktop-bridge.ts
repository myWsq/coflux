/**
 * 桌面 app 桥接（plan 103）：apps/desktop 的 preload 经 contextBridge 把这个对象挂到
 * `window.cofluxDesktop`；浏览器里它不存在。桌面差异一律靠「桥接对象存在」在运行时探测，
 * 不做编译期分叉——同一份 Web 产物既跑浏览器也跑 Electron。
 *
 * 桥接面刻意最小：服务器地址 / 自报 Origin / 通知 / Dock 角标 / 「聚焦工作区」回调 / 原生
 * 菜单命令 / 更新提示。不暴露 Node、fs、shell 之类通用能力。类型真相源在这里（web 拥有契约），
 * apps/desktop 只 type-import。
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
  /** app 版本（package.json version），与 web 的 BUILD_ID 是两个维度 */
  readonly version: string;
  /** /client WS 端点；桌面下没有可用的 location.host，地址只能来自 app 侧配置 */
  readonly serverUrl: string;
  /** 主进程在 WebSocket 握手上改写的稳定 https Origin；Web 侧经 deviceTransport.origin 上报同值 */
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

declare global {
  interface Window {
    cofluxDesktop?: DesktopBridge;
  }
}

/** 桌面判定的唯一入口：桥接存在即桌面。SSR/单元测试里没有 window 也安全。 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.cofluxDesktop ?? null;
}

export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}

/**
 * /client 端点地址：桌面由桥接给出（app 侧可配自托管地址）；浏览器沿用既有推导——
 * 构建期 VITE_COFLUX_SERVER 覆盖，否则同源 ws(s)://host/client。
 */
export function resolveServerUrl(input: {
  bridge: Pick<DesktopBridge, "serverUrl"> | null;
  envServerUrl: string | undefined;
  location: Pick<Location, "protocol" | "host">;
}): string {
  if (input.bridge) return input.bridge.serverUrl;
  if (input.envServerUrl) return input.envServerUrl;
  return `${input.location.protocol === "https:" ? "wss" : "ws"}://${input.location.host}/client`;
}
