import type { NativeTransportBridge } from "./native-transport";
/**
 * 桌面桥接的类型真相源（plan 106）：preload 经 contextBridge 把实现挂到 `window.cofluxDesktop`，
 * 渲染层假定它必定存在（缺失即启动期报错，见 renderer/desktop-bridge.ts）。主进程 / preload / 渲染层
 * 三方都只从这里 type-import；文件里只有类型，不带任何运行时代码。
 *
 * 桥接面刻意最小：服务器地址（含「服务器地址…」原生对话框）/ 自报 Origin / 通知 / Dock 角标 /
 * 「聚焦工作区」回调 / 原生菜单命令 / 更新提示 / 会话 token 存取 / 本机 daemon 的状态对象与窄动词。
 * 不暴露 Node、fs、shell 之类通用能力。
 */

/**
 * 本机 daemon（plan 113）的可见状态。主进程按 ~/.coflux 与 launchd 的事实派生（main/daemon-state.ts），
 * 渲染层只消费：
 * - not-installed：plist 或二进制缺失（不分 npm / app 来源）
 * - stopped：已接入但 launchd 里没有活进程
 * - pending-auth：在跑、还没有 credentials.json（authToken 有值时可用当前登录态兑现）
 * - running：在跑、已登记
 * - update-ready：在跑、已登记、内置 supervisor 比在跑的新（只提示，点「重启」才换二进制）
 * 完全磁盘访问单独用 fda 表达，与上面任一状态可叠加。
 */
export type DesktopDaemonStatus = "not-installed" | "stopped" | "pending-auth" | "running" | "update-ready";

/** 主进程正在执行的动作；接入拆成 install（落盘三件 + settings + plist）与 start（launchctl load）两步 */
export type DesktopDaemonBusy = "install" | "start" | "restart" | "stop" | "remove";

export type DesktopDaemonFda = "granted" | "denied" | "unknown";

export type DesktopDaemonState = {
  runningTerminals?: number;
  legacyInstallation?: boolean;
  status: DesktopDaemonStatus;
  /** 本构建是否自带三件；false（未打包 dev 实例没跑 stage 脚本）时「接入」「重启换新」都不可用，只能看状态 */
  bundled: boolean;
  /** 内置 supervisor 的版本戳原文（VERSION sidecar；解析不了如 dev 时永不提示升级） */
  bundledVersion?: string;
  /** 在跑的 supervisor 写的 ~/.coflux/supervisor-version 原文；缺失 = 112 之前的老版本 */
  runningVersion?: string;
  installed: boolean;
  running: boolean;
  registered: boolean;
  /** 等待授权时 pending-auth.json 链接里的一次性 token；渲染层用 client.authorizeDevice(token) 兑现 */
  authToken?: string;
  /** 该链接的过期时刻（ms epoch）；daemon 到期会自动换新链接 */
  authExpiresAt?: number;
  fda: DesktopDaemonFda;
  /** 本机设备在目录里的身份（credentials.json 的 daemonId），渲染层据此数本机运行中终端 */
  daemonId?: string;
  /** ~/.coflux/bin：给想在自己终端里直接用 coflux 的人看的路径提示（不改用户 shell 配置） */
  binDir: string;
  busy?: DesktopDaemonBusy;
  /** 上一次动作失败的步骤与原因；渲染层显示后可 daemonDismissError 清掉 */
  error?: { action: DesktopDaemonBusy; message: string };
};

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
export type DesktopCommand = "create-terminal" | "close-terminal" | "create-workspace" | "previous-tab" | "next-tab" | "toggle-help" | "open-settings";

export type DesktopNotification = {
  notificationId?: string;
  taskId?: string;
  /** 点击通知后主进程回传给渲染层的工作区 id，用于选中该工作区 */
  workspaceId: string;
  title: string;
  body: string;
};

export type DesktopBridge = {
  readonly nativeTransport?: NativeTransportBridge;
  readonly platform: string;
  /** app 版本（package.json version），与渲染层的 BUILD_ID 是两个维度 */
  readonly version: string;
  /** /client WS 端点；自定义 scheme 下没有可用的 location.host，地址只能来自 app 侧配置 */
  readonly serverUrl: string;
  /** 主进程在 WebSocket 握手上改写的稳定 https Origin；渲染层经 deviceTransport.origin 上报同值 */
  readonly origin: string;
  /**
   * 打开主进程的「服务器地址…」原生对话框（plan 110）：与原生菜单同一个入口，无参、fire-and-forget。
   * 渲染层自己弹不了——settings.json 路径与「打开设置文件」动作只有主进程有。
   */
  showServerInfo(): void;
  connectLocal(): Promise<void>;
  logoutLocal(): Promise<boolean>;
  notify(notification: DesktopNotification): void;
  /** Combined automatic attention and unread inbox count; zero clears the badge. */
  setBadge(count: number): void;
  onFocusNotification(listener: (notification: DesktopNotification) => void): () => void;
  onFocusWorkspace(listener: (workspaceId: string) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  checkForUpdates(): void;
  installUpdate(): void;
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  /**
   * 会话 token（plan 106）：主进程用 safeStorage 加密落 userData，渲染层不落任何明文。
   * 读不到（加密不可用 / 文件损坏 / 解密失败）返回空串 = 未登录。
   */
  getSessionToken(): Promise<string>;
  setSessionToken(token: string): void;
  clearSessionToken(): void;
  /**
   * 本机 daemon（plan 113）：一个状态对象 + 几个无参窄动词，主进程只做 ~/.coflux 落盘、launchctl、
   * codesign 与 FDA 引导两跳，桥接面不因此长出 fs / shell / 任意命令能力。
   * 「授权」在渲染层用 client.authorizeDevice(state.authToken) 完成；「暂不」是渲染层本地状态；
   * 「我已勾选 FDA，重启服务」就是 daemonRestart()。
   */
  getDaemonState(): Promise<DesktopDaemonState>;
  onDaemonState(listener: (state: DesktopDaemonState) => void): () => void;
  /** 接入这台 Mac：落盘三件 + settings.json + LaunchAgent，然后 launchctl load */
  daemonEnroll(): void;
  /** 重启服务；内置 supervisor 更新时先换二进制再重启（会结束本机所有终端） */
  daemonRestart(): void;
  daemonStop(): void;
  /** 移除接入：unload 并删 plist 与三个二进制，保留凭证 / 配置 / 日志（cofluxd uninstall 无 --purge 语义） */
  daemonRemove(): void;
  /** 打开系统设置的完全磁盘访问面板并在 Finder 定位 supervisor 二进制 */
  daemonOpenFdaGuide(): void;
  daemonDismissError(): void;
  /**
   * executor（plan 116）。渲染层是**信使**不是决策者：作业表、写锁、runner 与凭证全在主进程，
   * 它只负责把本机 daemon 的 device 通道两头接上，外加一个设置面。
   * `getExecutorSettings` 永远不含 API key——只有 `hasApiKey` 这个布尔。
   */
  getExecutorSettings(): Promise<DesktopExecutorSettings>;
  onExecutorSettings(listener: (settings: DesktopExecutorSettings) => void): () => void;
  setExecutorModel(provider: string, modelId: string): void;
  /** 空串 = 清除 */
  setExecutorApiKey(apiKey: string): void;
  /** device 通道收到 executor 帧时转进主进程 */
  sendExecutorInbound(message: DesktopExecutorInbound): void;
  /** 本机 daemon 的 device 通道通了 / 断了；daemonId 为空串表示断开 */
  setExecutorChannel(daemonId: string): void;
  /** 主进程要往 device 通道发的帧 */
  onExecutorOutbound(listener: (message: DesktopExecutorOutbound) => void): () => void;
};

/** 渲染层可见的 executor 配置——刻意没有 apiKey 字段。 */
export type DesktopExecutorSettings = {
  provider: string;
  modelId: string;
  hasApiKey: boolean;
  ready: boolean;
  reason: string;
};

export type DesktopExecutorInbound =
  | { kind: "assign"; runId: string; prompt: string; write: boolean; workspaceId: string; workspaceRoot: string; submittedAt: number }
  | { kind: "cancel"; runId: string }
  | { kind: "registered"; ok: boolean; error?: string; reconcileRunIds: string[] }
  | { kind: "ack"; runId: string };

export type DesktopExecutorOutbound =
  | { kind: "register"; hostId: string; hostEpoch: number; capabilities: string[]; ready: boolean; notReadyReason: string }
  | {
      kind: "report";
      runId: string;
      state: string;
      note: string;
      summary?: string;
      changedFiles?: string[];
      error?: string;
    };
