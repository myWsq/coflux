import { extname, posix } from "node:path";

// 纯函数部分（不 import electron），供 app-protocol.ts 与单测共用。

/**
 * 渲染层经自定义 scheme 从 asar 提供（plan 103）：生产构建不加载任何远程 URL，中心不可达时冷启动
 * 仍能进工作台。scheme 必须是 standard + secure（IndexedDB 身份、安全上下文、相对路径解析都依赖它），
 * 带 host 的形式 `coflux-app://app/` 让 pathname 是 `/`，App.tsx 按 pathname 选页才落到 MainPage。
 * 不占用 coflux://（留给将来深链接）。
 */
export const APP_SCHEME = "coflux-app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

/**
 * 渲染层响应的 CSP：脚本只许自身产物；样式放行 inline（index.html 的冷启动遮罩是内联 style 属性）；
 * 连接放行中心（wss/ws 任意 host，自托管地址可配）、loopback gateway 与 dev 中心；WebGL/WebRTC 不受
 * CSP 约束；不嵌任何 frame/object。
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws: http://127.0.0.1:* http://localhost:*",
  "worker-src 'self' blob:",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(relativePath: string): string {
  return CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * URL pathname → 渲染层产物内的 posix 相对路径。`/` 与不带扩展名的路径（SPA 路由）回落 index.html；
 * 带扩展名的按静态资源。解码后规范化，任何试图越出产物根的路径（`..`、绝对路径残留）返回 null。
 */
export function resolveRendererAsset(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = posix.normalize(`/${decoded}`);
  if (normalized.startsWith("/..") || normalized.includes("/../")) return null;
  const relative = normalized.replace(/^\/+/, "");
  if (relative === "" || !posix.basename(relative).includes(".")) return "index.html";
  return relative;
}
