import { BrowserWindow, screen, shell } from "electron";

import { isTrustedRendererUrl } from "./ipc-trust";
import type { RendererNavigation } from "./renderer-reset";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, readWindowBounds, resolveWindowBounds, writeWindowBounds } from "./window-state";

export type MainWindowOptions = {
  preloadPath: string;
  /** 要加载的 URL：打包为 coflux-app://app/，dev 为 ELECTRON_RENDERER_URL */
  url: string;
  trusted: { appOrigin: string; devRendererUrl?: string };
  /** app 正在退出（before-quit 之后）：此时关窗才真的关，否则只隐藏（保住连接与通知） */
  isQuitting: () => boolean;
  /** 窗口大小/位置记忆文件（userData/window-state.json，plan 106） */
  windowStatePath: string;
  /**
   * Dev-only instance label (plan 20260916-desktop-preview-parallel). Set, it prefixes the window
   * title so parallel previews are told apart in Mission Control and the Dock's window menu.
   * Absent — every packaged run — the title is whatever the renderer set, exactly as before.
   */
  instanceLabel?: string;
  /**
   * 页面完成一次导航（⌘R、devtools 重载、渲染进程崩溃恢复，以及首次 loadURL）。
   * 主进程里那份「属于渲染层」的状态在这里归零——见 renderer-reset.ts。
   */
  onNavigated?: (navigation: RendererNavigation) => void;
  /** bounds 写盘失败只记日志 */
  onStateError?: (error: unknown) => void;
  /**
   * Built-in browser tabs (plan 20260924-desktop-browser-tab): the gate every `<webview>` passes
   * before it attaches (it hardens the guest's preferences and may refuse it), and the hook that
   * adopts an attached guest. Absent, every webview is refused, as before the browser tab existed.
   */
  webviewGate?: (event: Electron.Event, webPreferences: Electron.WebPreferences, params: Record<string, string>) => void;
  onWebviewAttached?: (guest: Electron.WebContents) => void;
};

/** 只有 http(s) 外链交给系统浏览器；其它 scheme（javascript:、file:、自定义）一律丢弃。 */
export function openExternalIfHttp(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") void shell.openExternal(url);
  } catch {
    /* 非法 URL：不打开 */
  }
}

/**
 * 主窗口（plan 103）：隐藏标题栏 + 红绿灯内嵌到侧栏顶部（IDE 式，渲染层给侧栏留出拖拽区）。
 * 安全基线：sandbox / contextIsolation 默认开，nodeIntegration 关；webview 只经 browser-host.ts 的闸门挂载
 * （plan 20260924-desktop-browser-tab：无 preload、沙箱、只认预先准备好的分区）；新窗口一律拒绝、
 * 外链交系统浏览器；离开 app 自身来源的导航拦下（授权页 / OAuth 同意页 / 端口预览都在系统浏览器）。
 * 大小/位置（plan 106）：上次关窗/退出时保存的 bounds 若仍落在某个显示器上就恢复，否则默认尺寸居中。
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const restored = resolveWindowBounds(
    readWindowBounds(options.windowStatePath),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    width: restored?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: restored?.height ?? DEFAULT_WINDOW_SIZE.height,
    // x/y 不给时 Electron 默认居中（首次启动与离屏回退都走这条）
    x: restored?.x,
    y: restored?.y,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 14 },
    // 与 index.html 的冷启动遮罩同色，窗口出现到 HTML 到达之间不白闪
    backgroundColor: "#111214",
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The built-in browser tab embeds pages with <webview>; every one of them passes webviewGate.
      webviewTag: true,
      spellcheck: false,
    },
  });

  // The renderer rewrites `document.title` on every selection change, so a title set once at
  // creation is gone within a second of use: intercept the update and re-apply the label instead.
  const label = options.instanceLabel;
  if (label) {
    window.setTitle(label);
    window.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      window.setTitle(`${label} · ${title}`);
    });
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, options.trusted)) return;
    event.preventDefault();
    openExternalIfHttp(url);
  });

  // The blanket deny became a gate (plan 20260924-desktop-browser-tab); without one, nothing attaches.
  const gate = options.webviewGate;
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (gate) gate(event, webPreferences, params);
    else event.preventDefault();
  });
  const onWebviewAttached = options.onWebviewAttached;
  if (onWebviewAttached) window.webContents.on("did-attach-webview", (_event, guest) => onWebviewAttached(guest));

  // 挂在 did-navigate 上：它只在主 frame 的跨文档导航**提交之后**触发（页内导航走
  // did-navigate-in-page），被上面 will-navigate 拦下的外链导航根本不会走到这里。两个标记
  // 显式传给纯函数，判定与测试都留在 renderer-reset.ts。注册必须早于 loadURL，首次加载也要收到。
  const onNavigated = options.onNavigated;
  if (onNavigated) {
    window.webContents.on("did-navigate", (_event, url) => onNavigated({ url, isMainFrame: true, isSameDocument: false }));
  }

  window.once("ready-to-show", () => window.show());

  window.on("close", (event) => {
    // 关窗（隐藏）与退出都经这里：先记下常规态 bounds（全屏/最大化时取的是还原后的尺寸）
    if (!window.isDestroyed()) writeWindowBounds(options.windowStatePath, window.getNormalBounds(), options.onStateError);
    if (options.isQuitting()) return;
    // macOS 惯例：关窗不退出。这里进一步选择「隐藏」而非销毁——保住中心连接与通知/角标，
    // Dock 点击或通知点击即恢复，不用重新登录/重新 attach。
    event.preventDefault();
    window.hide();
  });

  void window.loadURL(options.url);
  return window;
}
