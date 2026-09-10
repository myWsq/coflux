import { join } from "node:path";
import { app, protocol, session, type BrowserWindow } from "electron";

import { APP_ORIGIN, APP_SCHEME, APP_URL, registerAppProtocol } from "./app-protocol";
import { registerIpc } from "./ipc";
import { DESKTOP_ORIGIN, rewriteHandshakeHeaders } from "./origin";
import { readSettingsFile, resolveServerUrl } from "./settings";
import { createMainWindow } from "./window";

// scheme 特权只能在 ready 之前注册一次：standard（有 host、相对路径可解析）+ secure（安全上下文，
// IndexedDB/crypto.subtle 可用）+ fetch/流式/代码缓存。不 bypassCSP——CSP 由响应头自己带。
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// electron-vite dev 注入；打包运行时为空 → 一律走 coflux-app://app/
const devRendererUrl = process.env.ELECTRON_RENDERER_URL;
const trusted = { appOrigin: APP_ORIGIN, devRendererUrl };

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function currentServerUrl(): string {
  return resolveServerUrl({
    argv: process.argv,
    env: process.env,
    fileServerUrl: readSettingsFile(join(app.getPath("userData"), "settings.json")).serverUrl,
    packaged: app.isPackaged,
  });
}

/** 两条 WebSocket 握手（中心 /client、loopback /device）的 Origin 改写；判定见 origin.ts。 */
function installOriginRewrite(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = rewriteHandshakeHeaders(
      { url: details.url, resourceType: details.resourceType, requestHeaders: details.requestHeaders },
      devRendererUrl,
    );
    callback(headers ? { requestHeaders: headers } : {});
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("activate", () => {
    // Dock 点击：窗口只是隐藏时恢复；已被销毁（不会发生，close 只隐藏）则重建
    if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app.whenReady().then(() => {
    registerAppProtocol(join(app.getAppPath(), "out", "renderer"));
    installOriginRewrite();

    // 渲染层不需要任何浏览器权限：通知走主进程 Notification，不经 Web Notification API；
    // 只放行全屏与剪贴板写入（用户手势）。其余（摄像头/麦克风/地理位置/...）一律拒绝。
    const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowedPermissions.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));

    const serverUrl = currentServerUrl();
    registerIpc(
      {
        bootstrap: () => ({ platform: process.platform, version: app.getVersion(), serverUrl, origin: DESKTOP_ORIGIN }),
      },
      trusted,
    );

    mainWindow = createMainWindow({
      preloadPath: join(app.getAppPath(), "out", "preload", "index.cjs"),
      url: devRendererUrl ?? APP_URL,
      trusted,
      isQuitting: () => quitting,
    });
  });
}
