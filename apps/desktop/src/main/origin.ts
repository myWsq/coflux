/**
 * WebSocket 握手 Origin 改写（plan 103）。
 *
 * 渲染层跑在自定义 scheme `coflux-app://app` 下，浏览器会把它作为 Origin 头发出；而中心
 * `validOrigin` 只接受 http/https（apps/server/src/local-control.ts）、hub 要求 pair 自报 origin 与
 * `/client` 握手 Origin 精确相等、daemon 按中心下发的 origin 白名单拒绝 loopback 握手——三处零放宽。
 * 于是由主进程在渲染层发起的每一条 WebSocket 握手上写入同一个稳定的 https Origin，Web 侧经
 * deviceTransport.origin 上报同值；relay 握手一并改写（relay 不看 Origin，但同一身份更一致）。
 *
 * 纯函数，不 import electron，便于单测。
 */

/**
 * 桌面 app 的稳定 Origin。要求：https、跨版本不变、与 Web 的 https://app.coflux.dev 不同（grant 列表
 * 里能区分桌面 app）、不要求可解析。一旦发布即 grant 绑定的一部分：改它 = 所有桌面 loopback grant 失效。
 */
export const DESKTOP_ORIGIN = "https://desktop.coflux.dev";

export type HandshakeDetails = {
  url: string;
  /** Electron webRequest 的 resourceType；只有 "webSocket" 才是握手 */
  resourceType: string;
  requestHeaders: Record<string, string>;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 哪些请求改：WebSocket 握手（resourceType 为 webSocket 且 ws/wss URL）。
 * 排除 dev 渲染层自己的 HMR 连接（excludedOrigin = ELECTRON_RENDERER_URL）：那条 WS 属于 vite，不是应用身份。
 * 非 WebSocket（脚本/样式/xhr/fetch）一律不动。
 */
export function shouldRewriteOrigin(url: string, resourceType: string, excludedOrigin?: string): boolean {
  if (resourceType !== "webSocket") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
  if (excludedOrigin) {
    const excludedHost = hostOf(excludedOrigin);
    if (excludedHost && parsed.host === excludedHost) return false;
  }
  return true;
}

/**
 * 返回改写后的请求头；不该改时返回 null（调用方原样放行）。
 * 只动 Origin（大小写不敏感地替换既有键），其余头（Sec-WebSocket-* 等）原封不动。
 */
export function rewriteHandshakeHeaders(details: HandshakeDetails, excludedOrigin?: string, origin = DESKTOP_ORIGIN): Record<string, string> | null {
  if (!shouldRewriteOrigin(details.url, details.resourceType, excludedOrigin)) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(details.requestHeaders)) {
    if (key.toLowerCase() === "origin") continue;
    headers[key] = value;
  }
  headers.Origin = origin;
  return headers;
}
