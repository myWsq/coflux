import { BrowserWindow, shell } from "electron";

import { isTrustedRendererUrl } from "./ipc-trust";

export type MainWindowOptions = {
  preloadPath: string;
  /** 要加载的 URL：打包为 coflux-app://app/，dev 为 ELECTRON_RENDERER_URL */
  url: string;
  trusted: { appOrigin: string; devRendererUrl?: string };
  /** app 正在退出（before-quit 之后）：此时关窗才真的关，否则只隐藏（保住连接与通知） */
  isQuitting: () => boolean;
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
 * 安全基线：sandbox / contextIsolation 默认开，nodeIntegration 关，webview 关；新窗口一律拒绝、
 * 外链交系统浏览器；离开 app 自身来源的导航拦下（授权页 / OAuth 同意页 / 端口预览都在系统浏览器）。
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
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
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, options.trusted)) return;
    event.preventDefault();
    openExternalIfHttp(url);
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  window.once("ready-to-show", () => window.show());

  window.on("close", (event) => {
    if (options.isQuitting()) return;
    // macOS 惯例：关窗不退出。这里进一步选择「隐藏」而非销毁——保住中心连接与通知/角标，
    // Dock 点击或通知点击即恢复，不用重新登录/重新 attach。
    event.preventDefault();
    window.hide();
  });

  void window.loadURL(options.url);
  return window;
}
