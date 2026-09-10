import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

import { APP_HOST, APP_SCHEME, RENDERER_CSP, contentTypeFor, resolveRendererAsset } from "./app-protocol-pure";

export { APP_HOST, APP_ORIGIN, APP_SCHEME, APP_URL, RENDERER_CSP } from "./app-protocol-pure";

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * 注册 `coflux-app://app/*` 的处理器：只服务 rendererRoot 下的文件（asar 内），响应带 CSP。
 * 须在 app ready 之后调用；scheme 特权注册（registerSchemesAsPrivileged）在 ready 之前，见 index.ts。
 */
export function registerAppProtocol(rendererRoot: string): void {
  const root = rendererRoot.endsWith(sep) ? rendererRoot : rendererRoot + sep;
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const relative = resolveRendererAsset(url.pathname);
    if (relative === null) return notFound();
    let filePath = join(root, ...relative.split("/"));
    if (!filePath.startsWith(root)) return notFound();
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      // 静态资源不存在 → 404；SPA 路径已经在 resolveRendererAsset 回落 index.html，这里不再兜底。
      if (relative === "index.html") return new Response("renderer bundle missing", { status: 500 });
      return notFound();
    }
    const upstream = await net.fetch(pathToFileURL(filePath).toString(), { bypassCustomProtocolHandlers: true });
    const headers = new Headers();
    headers.set("Content-Type", contentTypeFor(relative));
    headers.set("Content-Security-Policy", RENDERER_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    // 产物文件名带内容 hash，index.html 不带：前者可长缓存，后者不缓存（asar 更新即新版本）。
    headers.set("Cache-Control", relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}
