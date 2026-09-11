/**
 * IPC 发送方校验（plan 103 安全基线）：只接受来自 app 自己渲染层（打包：coflux-app://app/*；
 * dev：ELECTRON_RENDERER_URL 同源）的顶层 frame。纯函数，便于单测。
 */
export function isTrustedRendererUrl(url: string | undefined | null, trusted: { appOrigin: string; devRendererUrl?: string }): boolean {
  if (!url) return false;
  if (url === trusted.appOrigin || url.startsWith(`${trusted.appOrigin}/`)) return true;
  if (trusted.devRendererUrl) {
    try {
      return new URL(url).origin === new URL(trusted.devRendererUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}
