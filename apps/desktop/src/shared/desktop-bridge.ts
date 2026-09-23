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

/**
 * 主进程正在执行的动作；接入拆成 install（落盘三件 + settings + plist）与 start（launchctl load）两步。
 * `connect` is the account check that runs before an enrollment. It is its own action rather than
 * part of `start` because it fails for its own reasons — no network, another account owns this Mac —
 * while the local runtime may be running perfectly; borrowing `start`'s label would misname the cause.
 */
export type DesktopDaemonBusy = "connect" | "install" | "start" | "restart" | "stop" | "remove";

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

/** 原生菜单项触发的命令；语义与 use-global-shortcuts.ts 的键位一一对应，⌘1-9 / ⌘⌥1-9 不进菜单。 */
export type DesktopCommand =
  | "create-terminal"
  | "close-terminal"
  | "create-workspace"
  | "previous-tab"
  | "next-tab"
  /** ⌘\ / ⌘⇧\: split the focused group and open a new terminal in the new group. */
  | "split-right"
  | "split-down"
  /** ⌘⌥←/→/↑/↓: move focus to the adjacent group. */
  | "focus-group-left"
  | "focus-group-right"
  | "focus-group-up"
  | "focus-group-down"
  | "toggle-help"
  | "open-settings"
  | "toggle-palette";

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
  /**
   * 把一段文本写进系统剪贴板（终端里的 OSC 52 用）。必须走主进程：OSC 52 是 PTY 输出流上
   * 冒出来的，背后没有任何用户手势，`navigator.clipboard.writeText()` 在页面失焦时必被拒——
   * 而"后台 agent 干完活复制一段东西"恰恰就是失焦那一刻。只有写，没有读。
   */
  writeClipboard(text: string): void;
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
   * executor（plan 116；配置改由账号持有见 plan 20260918）。渲染层是**信使与设置面**，不是决策者：
   * 作业表、写锁、runner、模型运行时与凭据全在主进程。
   *
   * **凭据是单向的**：渲染层可以把用户刚输入的 key 交给主进程，但永远拿不回任何形式的凭据——
   * `getExecutorSettings` 只有「哪些 provider 配过」，没有值，也没有密文。配置本身来自本机 daemon
   * 写下的缓存文件，主进程直接读，不经这里。
   */
  getExecutorSettings(): Promise<DesktopExecutorSettings>;
  onExecutorSettings(listener: (settings: DesktopExecutorSettings) => void): () => void;
  /** 内置 provider + 用户自定义端点，以及可跨 provider 搜索的模型清单。 */
  getExecutorCatalog(): Promise<DesktopExecutorCatalog>;
  /** 保存：主进程先本机校验，再写中心，再等本机 daemon 把它取回来。 */
  saveExecutorSettings(input: DesktopExecutorSaveInput): Promise<DesktopExecutorSaveResult>;
  /** 真发一次最小请求确认联通；会花钱，所以只在用户显式点击时调。 */
  testExecutorConnection(): Promise<DesktopExecutorTestResult>;
  /** device 通道收到 executor 帧时转进主进程 */
  sendExecutorInbound(message: DesktopExecutorInbound): void;
  /**
   * 本机 daemon 的 device 通道通了 / 断了；daemonId 为空串表示断开。
   * `generation` 标识**这一次连接**：同一个 daemon 断开重连会换一个号，主进程据此重新报到——
   * 只比 daemonId 的话，重连后 daemon 早已忘掉 host，agent 那头会看到「本机 Coflux.app 没在跑」。
   */
  setExecutorChannel(daemonId: string, generation: number): void;
  /** 主进程要往 device 通道发的帧 */
  onExecutorOutbound(listener: (message: DesktopExecutorOutbound) => void): () => void;
};

/** 一个自定义端点的定义。**不含凭据**——它单独走 `apiKey` 字段，且只往主进程去。 */
export type DesktopExecutorCustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: { id: string; name: string }[];
  /** pi 的兼容开关：是否额外带 Authorization 头。 */
  authHeader: boolean;
  /** Ollama 这类本机 keyless 服务：不需要 key。 */
  keyless: boolean;
};

/** 渲染层可见的 executor 配置——刻意没有任何凭据字段。 */
export type DesktopExecutorSettings = {
  provider: string;
  modelId: string;
  hasApiKey: boolean;
  ready: boolean;
  reason: string;
  /** false = 本机 daemon 还没把账号里的配置写下来（没在跑，或版本过旧）。 */
  present: boolean;
  /** 中心解不开已存密文时的可读原因。非空 ≠ 没配过。 */
  credentialError: string;
  customProviders: DesktopExecutorCustomProvider[];
  /** 已有凭据的 provider id；只有 id。 */
  credentialProviders: string[];
  revision: number;
};

export type DesktopExecutorProviderOption = { id: string; name: string; custom: boolean; keyless: boolean };

export type DesktopExecutorModelOption = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  /** null = 未知。自定义端点手填的模型带的是占位元数据，不能当真实规格展示。 */
  contextWindow: number | null;
  /** 每百万 token 的输入/输出价格；未知同上。 */
  cost: { input: number; output: number } | null;
};

export type DesktopExecutorCatalog = {
  /** false = 模型运行时起不来，`error` 说明原因，设置页只能只读。 */
  ready: boolean;
  error: string;
  providers: DesktopExecutorProviderOption[];
  models: DesktopExecutorModelOption[];
};

export type DesktopExecutorSaveInput = {
  provider: string;
  modelId: string;
  /** undefined = 不改动已存的 key；空串 = 清除。 */
  apiKey?: string;
  customProviders: (DesktopExecutorCustomProvider & { apiKey?: string })[];
};

export type DesktopExecutorSaveResult = {
  ok: boolean;
  /** 失败原因，按 provider 不存在 / 模型不存在 / 凭据没过 / 中心拒绝 / 离线分开说。 */
  error?: string;
  /** 成功时的一句「已校验」——不花钱的那部分校验通过了。 */
  validated?: string;
  /** 保存成功但下发没到位（daemon 太旧或不在线），或中心读不出旧密文。 */
  warning?: string;
};

export type DesktopExecutorTestResult = { ok: boolean; error?: string; tokens?: number; ms?: number };

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
