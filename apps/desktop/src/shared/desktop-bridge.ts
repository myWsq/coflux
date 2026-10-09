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
 * - update-ready：在跑、已登记、内置运行组件与在跑的不是同一个；怎么换见 `runtimeUpdate`
 * 完全磁盘访问单独用 fda 表达，与上面任一状态可叠加。
 */
export type DesktopDaemonStatus = "not-installed" | "stopped" | "pending-auth" | "running" | "update-ready";

/**
 * 主进程正在执行的动作；接入拆成 install（落盘三件 + settings + plist）与 start（launchctl load）两步。
 * `connect` is the account check that runs before an enrollment. It is its own action rather than
 * part of `start` because it fails for its own reasons — no network, another account owns this Mac —
 * while the local runtime may be running perfectly; borrowing `start`'s label would misname the cause.
 * `update` is a restart that moves the runtime onto the bundled version (automatic or 「重试」);
 * its failure line must read as an update that did not apply, not as a restart that failed.
 */
export type DesktopDaemonBusy = "connect" | "install" | "start" | "restart" | "update" | "stop" | "remove";

/**
 * How a stale local runtime (status `update-ready`) gets onto the bundled version
 * (plan 20261002-runtime-follows-app):
 * - automatic: the terminals live in ptyd, so the main process asks the launcher to switch (or
 *   replaces the launcher) by itself, at most once per app launch per bundled runtime; nothing to click
 * - failed: that attempt did not come up and the previous version was restored; the panel offers
 *   「重试」, which runs the same replacement again
 * - manual: the running supervisor predates ptyd (or ptyd is not there), replacing it ends the
 *   terminals; the panel keeps 「更新」 and the main process asks for confirmation
 */
export type DesktopRuntimeUpdate = "automatic" | "failed" | "manual";

export type DesktopDaemonFda = "granted" | "denied" | "unknown";

export type DesktopDaemonState = {
  /** 本机正在运行的终端数：来自 ptyd（launcher 缺席时也准确），否则来自 runtime.sock */
  runningTerminals?: number;
  legacyInstallation?: boolean;
  /**
   * 内置的 coflux-ptyd 与在跑的不是同一个二进制（plan 20260918-ptyd-terminal-custody）。这是单独的动作
   * 「更新终端组件」：它会结束本机终端，所以要确认；普通的运行组件更新不受它影响、也不清它。
   */
  ptydUpdateReady?: boolean;
  /** Present exactly when the running runtime is not the bundled one (status `update-ready`). */
  runtimeUpdate?: DesktopRuntimeUpdate;
  status: DesktopDaemonStatus;
  /** 本构建是否自带三件；false（未打包 dev 实例没跑 stage 脚本）时「接入」「重启换新」都不可用，只能看状态 */
  bundled: boolean;
  /** 内置运行组件的版本戳原文（VERSION sidecar；解析不了如 dev 时永不提示升级） */
  bundledVersion?: string;
  /** 在跑的 runtime 写的 ~/.coflux/runtime-version 原文；缺失 = 老版本 */
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

/** Commands sent by native menu items; each matches a key in use-global-shortcuts.ts. ⌘1-9 and ⌘⌥1-9 have no menu entries. */
export type DesktopDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type DesktopCommand =
  /** ⌘T: toggle the focused group's new-tab menu (terminal or browser). */
  | "new-tab"
  /** 文件 → 新建终端; no keyboard shortcut. */
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
  /**
   * ⌘1–9 / ⌘⌥1–9 (plan 20260924-desktop-browser-tab). The menu has no items for these — the renderer
   * handles the keys itself — but a focused browser page swallows keys before the renderer sees
   * them, so the main process forwards them through this channel.
   */
  | `focus-group-${DesktopDigit}`
  | `select-tab-${DesktopDigit}`
  /** 文件 → 新建浏览器标签页 (plan 20260924-desktop-browser-tab); no keyboard shortcut. */
  | "new-browser-tab"
  /** 文件 → 新建屏幕标签页 (plan 20260929-remote-desktop); no keyboard shortcut. */
  | "new-screen-tab"
  | "toggle-help"
  /** ⌘B / 视图 → 显示/隐藏侧边栏 (plan 20260930-collapsible-sidebar): collapse or expand the workbench sidebar. */
  | "toggle-sidebar"
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

/** Where a clicked attention notification lands: the waiting terminal, else its workspace. */
export type DesktopFocusTarget = Pick<DesktopNotification, "workspaceId" | "taskId">;

/**
 * Remote screen tabs (plan 20260929-remote-desktop). A session's two device lanes (control and
 * video, RPC scope) are opened and owned by the main process under an identity of this app run's
 * own; the renderer encodes and decodes the DeviceEnvelopes itself and talks to main over a
 * MessagePort so video frames cross as transferred buffers, never structured clones. Main also
 * polls the local clipboard while asked to and writes it on request, and switches its menu
 * accelerators off while the picture has focus.
 */
export type DesktopScreenLaneKind = "control" | "video";
export type DesktopScreenLane = {
  channelId: string;
  /** The principal the worker checks ScreenSessionOpen against. */
  clientInstanceId: string;
  /** Decimal string of the lane's transport generation. */
  generation: string;
};
/** What main posts on the session's port. */
export type DesktopScreenPortMessage =
  | { type: "lanes"; control: DesktopScreenLane; video: DesktopScreenLane }
  | { type: "lanes-failed"; message: string }
  | { type: "frame"; lane: DesktopScreenLaneKind; data: ArrayBuffer }
  | { type: "closed"; lane: DesktopScreenLaneKind }
  | { type: "clipboard"; text?: string; png?: ArrayBuffer };
/** What the renderer posts on the session's port. */
export type DesktopScreenPortRequest =
  | { type: "send"; lane: DesktopScreenLaneKind; data: ArrayBuffer }
  /** Open the lanes (again) — after `closed`, when the device is reachable again. */
  | { type: "reopen" }
  | { type: "clipboard-set"; text?: string; png?: ArrayBuffer }
  | { type: "clipboard-watch"; on: boolean };
/** The window message the preload posts to the page with the session's port in `ports[0]`. */
export const SCREEN_PORT_MESSAGE = "coflux-screen-port";
export type DesktopScreenEvent = { kind: "fullscreen"; on: boolean };

/**
 * Built-in browser tabs (plan 20260924-desktop-browser-tab). Whether a workspace's `localhost` is
 * this Mac (`local`) or another device (`remote`) is decided by the main process from the local
 * daemon id, never by the renderer. A remote workspace's loopback requests reach its device through
 * the device tunnel (plan 20260924-remote-localhost-tunnel).
 */
export type DesktopBrowserMode = "local" | "remote";

/**
 * Why a remote workspace's loopback load failed: the device is offline or unreachable, nothing
 * listens on that port on the device, or the device's coflux predates the tunnel.
 */
export type DesktopBrowserTunnelFailure = "offline" | "refused" | "unsupported";

export type DesktopBrowserPrepared = { partition: string; mode: DesktopBrowserMode };

/**
 * Who owns a browser partition's state (plan 20260929-browser-scope-partitions): a project, shared
 * by every worktree of it (`id` = project id), or a device, for the device view's directory
 * workspace (`id` = daemon id). The renderer derives it from the workspace; tabs still belong to
 * their workspace.
 */
export type DesktopBrowserScope = { kind: "project" | "device"; id: string };

/** Toolbar and menu actions on one page guest. */
export type DesktopBrowserCommand = "back" | "forward" | "reload" | "hard-reload" | "stop" | "zoom-in" | "zoom-out" | "zoom-reset";

/** ⋯ → 清除 Cookies / 清除缓存 / 清除已信任的证书: always the current workspace's partition only. */
export type DesktopBrowserClearTarget = "cookies" | "cache" | "certificates";

/** A region of the page, as fractions (0..1) of the frozen frame's width and height. */
export type DesktopBrowserRect = { x: number; y: number; width: number; height: number };

/** The certificate a top-level load failed on, for the trust prompt. */
export type DesktopBrowserCertificate = {
  host: string;
  /** Chromium's verification result, e.g. `net::ERR_CERT_AUTHORITY_INVALID`. */
  error: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  /** Seconds since the epoch. */
  validExpiry: number;
};

/**
 * Browser annotations (plans 20260929-browser-annotations, 20260929-annotation-polish). The main
 * process instruments a page guest over CDP in an isolated world (hover highlight, level traversal,
 * shift-click selections, shift-drag regions, hit-testing, rects, pins and outlines); the renderer
 * owns the cards, the attachments and the side panel. Coordinates are CSS pixels of the page's
 * viewport, which the renderer scales onto its webview.
 */
export type DesktopAnnotatorLocator = {
  selector: string;
  domPath: string;
  tag: string;
  text: string;
  elementId: string;
  classes: string[];
};

/** A dragged region, in CSS pixels relative to the top-left corner of the annotation's first element. */
export type DesktopAnnotatorRegion = { x: number; y: number; width: number; height: number };

/**
 * An annotation shown on the page: a numbered pin (a check once resolved) on its first element's
 * top-right outer edge, or on its region's top-left corner. `targets[0]` is the anchor; the others
 * are outlined only while the annotation is outlined.
 */
export type DesktopAnnotatorPin = {
  id: string;
  number: number;
  resolved: boolean;
  targets: DesktopAnnotatorLocator[];
  region: DesktopAnnotatorRegion | null;
};

/** What the page reports the rectangle of: the elements just picked, or an annotation. */
export type DesktopAnnotatorAnchor = { kind: "pick"; token: string } | { kind: "pin"; id: string; scroll: boolean } | null;

/** The renderer's whole wish for one page guest; main re-applies it after every navigation. */
export type DesktopAnnotatorState = {
  /** Annotate mode: hover, ↑↓ levels, click, shift-click, shift-drag. */
  mode: boolean;
  /** A card is open over the page: the page swallows pointer input and reports clicks as outside clicks. */
  capture: boolean;
  pins: DesktopAnnotatorPin[];
  anchor: DesktopAnnotatorAnchor;
  /** Annotations whose elements or region are outlined (the selected one, an open card's, the hovered panel row's). */
  outlined: string[];
};

export type DesktopAnnotatorElement = DesktopAnnotatorLocator & {
  attributes: Record<string, string>;
  styles: Record<string, string>;
  width: number;
  height: number;
};

/** Framework source identity read from the page's development data; best effort. */
export type DesktopAnnotatorSource = { framework: string; components: string[]; file: string; line: number; column: number };

/** A rectangle in CSS pixels of the page's viewport, and that viewport's size. */
export type DesktopAnnotatorBox = { x: number; y: number; width: number; height: number };
export type DesktopAnnotatorViewport = { width: number; height: number };

/** One picked element and its framework source identity (null when the page exposes none or reading it failed). */
export type DesktopAnnotatorPickTarget = { element: DesktopAnnotatorElement; source: DesktopAnnotatorSource | null };

/**
 * What the user picked in annotate mode: one clicked element, a shift-click selection, or a
 * shift-dragged region (then `targets[0]` is the innermost element containing it and the others the
 * top-level elements inside it).
 */
export type DesktopAnnotatorPick = {
  token: string;
  url: string;
  title: string;
  /** The union of the elements, or the region, in the page's viewport. */
  rect: DesktopAnnotatorBox;
  viewport: DesktopAnnotatorViewport;
  targets: DesktopAnnotatorPickTarget[];
  region: DesktopAnnotatorRegion | null;
  /** The screenshot of `rect` as a `data:` URL; null when capturing failed. */
  screenshot: string | null;
};

/**
 * Main → renderer. Page guests are named by their webContents id (`<webview>.getWebContentsId()`),
 * which the renderer maps back to its tab.
 */
export type DesktopBrowserEvent =
  /** The page took keyboard focus (a click into it): its group becomes the focused one. */
  | { kind: "focus"; guestId: number }
  /** A browser key pressed inside the page: ⌘L, ⌥⌘I. */
  | { kind: "key"; guestId: number; action: "focus-address" | "toggle-devtools" | "toggle-annotate" }
  /** `window.open` / `target=_blank`: open the URL as a new browser tab beside the opener. */
  | { kind: "popup"; guestId: number; url: string }
  /** The page's favicon, fetched through its own session and handed over as a `data:` URL. */
  | { kind: "favicon"; guestId: number; pageUrl: string; dataUrl: string | null }
  /** Navigation state after a navigation or a zoom change. */
  | { kind: "history"; guestId: number; canGoBack: boolean; canGoForward: boolean; zoomFactor: number }
  | { kind: "devtools-closed"; guestId: number }
  /** A download from any browser page landed in the Downloads folder (or did not). */
  | { kind: "download"; filename: string; state: "completed" | "cancelled" | "interrupted" }
  /** A scope's `localhost` changed meaning (the local daemon registered after it was prepared); reaches every tab of that scope. */
  | { kind: "mode"; scope: DesktopBrowserScope; mode: DesktopBrowserMode }
  /** Browser annotations: elements or a region were picked in annotate mode. */
  | { kind: "annotator-pick"; guestId: number; pick: DesktopAnnotatorPick }
  /** Where the anchored element is now (it follows scrolling); null when it is gone or off the page. */
  | { kind: "annotator-anchor"; guestId: number; rect: DesktopAnnotatorBox | null; viewport: DesktopAnnotatorViewport }
  | { kind: "annotator-pin-click"; guestId: number; annotationId: string }
  /** Pins whose element the current page does not have (「元素未找到」). */
  | { kind: "annotator-pins"; guestId: number; url: string; missing: string[] }
  /** Esc inside the page in annotate mode or while a card is open. */
  | { kind: "annotator-escape"; guestId: number }
  /** A click on the page while a card is open (the page swallowed it). */
  | { kind: "annotator-outside-click"; guestId: number }
  /** Whether the page can be instrumented right now. */
  | { kind: "annotator-status"; guestId: number; available: boolean };

/** Sign-in providers the desktop may offer (plan 20260923); the server says which are enabled. */
export type DesktopLoginProvider = "github" | "google";

export type DesktopLoginOptions = {
  /** Only these get buttons; empty = the password form alone, never a dead button. */
  providers: DesktopLoginProvider[];
};

/**
 * Outcome of a browser sign-in. The token itself never crosses the bridge in this result: the main
 * process stores it (same path as `setSessionToken`) and the renderer reads it back to connect.
 */
export type DesktopBrowserLoginResult =
  | { ok: true; login: string }
  | { ok: false; reason: "not_allowed" | "not_verified" | "cancelled" | "timeout" | "network" | "failed"; message: string };

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
  /** An attention notification was clicked: its workspace and, when known, the waiting terminal. */
  onFocusWorkspace(listener: (target: DesktopFocusTarget) => void): () => void;
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
   * Browser sign-in (plan 20260923): the system browser, a 127.0.0.1 loopback listener, PKCE and the
   * code exchange all live in the main process; the renderer only asks and learns the outcome.
   */
  getLoginOptions(): Promise<DesktopLoginOptions>;
  /** Opens the system browser; resolves when the login finished, failed, timed out or was cancelled. */
  startBrowserLogin(provider: DesktopLoginProvider): Promise<DesktopBrowserLoginResult>;
  /** 「重新打开浏览器」: the same pending request's page again. */
  reopenBrowserLogin(): void;
  /** 「取消」: the pending `startBrowserLogin` resolves with `cancelled`. */
  cancelBrowserLogin(): void;
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
  /**
   * 重启 / 更新运行组件（plan 20261002-runtime-launcher-merge）：PTY 在 ptyd 里，本机终端、屏幕与
   * 回滚都原样保留，不再确认；launcher 观察新版本、起不来自动回滚到上一版并在状态里报告。只有在跑的 supervisor
   * 早于 ptyd 时这一次才会结束终端（那时主进程照旧弹确认）。
   */
  daemonRestart(): void;
  /** 更新 coflux-ptyd 本身：会结束本机所有终端，主进程弹确认后停掉两者再从内置版本起 */
  daemonUpdatePtyd(): void;
  daemonStop(): void;
  /** 移除接入：unload 并删 plist 与三个二进制，保留凭证 / 配置 / 日志（cofluxd uninstall 无 --purge 语义） */
  daemonRemove(): void;
  /** 打开系统设置的完全磁盘访问面板并在 Finder 定位应用 */
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
  /**
   * Built-in browser tabs (plan 20260924-desktop-browser-tab). The renderer owns the `<webview>`
   * elements and the chrome around them; sessions, guest hardening, certificates, downloads,
   * screenshots, favicons and DevTools docking are the main process's. Order is always prepare →
   * insert the webview (with the returned partition, `src="about:blank"`) → navigate. A scope lives
   * on exactly one device: preparing it again with another `daemonId` is refused.
   */
  browserPrepare(scope: DesktopBrowserScope, daemonId: string): Promise<DesktopBrowserPrepared>;
  /** Loads an http(s) URL (or about:blank) in a page guest; anything else is refused by main. */
  browserNavigate(guestId: number, url: string): void;
  browserCommand(guestId: number, command: DesktopBrowserCommand): void;
  /** 截取可见区域: the whole visible page to the clipboard. */
  browserCaptureVisible(guestId: number): Promise<boolean>;
  /** 框选截图, step one: freezes the page's current frame and returns it as a `data:` URL. */
  browserFreeze(guestId: number): Promise<string | null>;
  /** Step two: the chosen region of the frozen frame to the clipboard. The frozen frame is released. */
  browserCaptureRegion(guestId: number, rect: DesktopBrowserRect): Promise<boolean>;
  browserReleaseFreeze(guestId: number): void;
  /** Docks the page's DevTools into a host `<webview>` (partition `BROWSER_DEVTOOLS_PARTITION`, still on about:blank). */
  browserOpenDevTools(guestId: number, hostGuestId: number): Promise<boolean>;
  browserCloseDevTools(guestId: number): void;
  /** Clears the scope's data: every worktree of a project at once. */
  browserClearData(scope: DesktopBrowserScope, target: DesktopBrowserClearTarget): Promise<boolean>;
  /** The certificate a load of `host` in this page's partition last failed on; null when none is known. */
  browserCertificate(guestId: number, host: string): Promise<DesktopBrowserCertificate | null>;
  /** 信任证书: remembers that certificate for `host` in this page's partition, across restarts. */
  browserTrustCertificate(guestId: number, host: string): Promise<boolean>;
  /**
   * Asked from `did-fail-load` of a loopback URL in a remote workspace: why the device tunnel failed
   * for that URL's port, or null when no recent tunnel failure explains it.
   */
  browserTunnelFailure(guestId: number, url: string): Promise<DesktopBrowserTunnelFailure | null>;
  onBrowserEvent(listener: (event: DesktopBrowserEvent) => void): () => void;
  /** Browser annotations: what the page should show and do; main instruments the guest on demand. */
  browserAnnotatorSync(guestId: number, state: DesktopAnnotatorState): void;
  /**
   * Remote screen tabs (plan 20260929-remote-desktop). `screenOpen` makes main own a session's two
   * lanes and hand the page a MessagePort (a `SCREEN_PORT_MESSAGE` window message with the port);
   * resolves false when this build has no native transport. `screenClose` drops the lanes and the port.
   */
  screenOpen(sessionId: string, daemonId: string): Promise<boolean>;
  screenClose(sessionId: string): void;
  /** The picture has keyboard focus: every menu accelerator (⌘Q, ⇧⌘W, ⌘R, ⌃⌘F, Edit) yields to it. */
  screenFocus(focused: boolean): void;
  /** Immersive mode: the window goes full screen (true) or back (false). */
  screenImmersive(on: boolean): void;
  onScreenEvent(listener: (event: DesktopScreenEvent) => void): () => void;
  /**
   * Changes view file menu (plan 20261001-changes-review-polish), offered only for workspaces on
   * this machine's own device. `root` is the workspace's absolute path and `path` a file relative
   * to it, never pre-joined: main refuses a relative path that is absolute or has `..`, a result
   * outside the root, and anything that is not an existing regular file.
   */
  revealWorkspaceFile(root: string, path: string): Promise<DesktopWorkspaceFileResult>;
  /** Opens the file with its default app. Also refuses executables, bundles and launcher files. */
  openWorkspaceFile(root: string, path: string): Promise<DesktopWorkspaceFileResult>;
};

export type DesktopWorkspaceFileResult = { ok: true } | { ok: false; error: string };

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

/** One transcript fragment of a desktop-hosted run (plan 20260929-executor-pip), as the executor
 * package emits it; the renderer forwards it verbatim to the local daemon over the device channel. */
export type DesktopExecutorFragment =
  | { kind: "assistant"; text: string; at: number }
  | { kind: "tool"; tool: string; argument: string; output: string; failed: boolean; at: number }
  | { kind: "error"; text: string; at: number };

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
    }
  | { kind: "transcript"; runId: string; fragment: DesktopExecutorFragment };
