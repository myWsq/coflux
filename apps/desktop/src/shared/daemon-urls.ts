/**
 * Daemon-facing URL helpers shared by the main process (local enrollment) and the renderer
 * (the 添加设备 dialog). Pure functions with no Electron / Node / renderer-alias imports, because
 * this file is compiled by both the main and the renderer tsconfig.
 */

/**
 * The daemon's server address follows the app: the /client endpoint becomes /daemon
 * (wss://api.coflux.dev/client → wss://api.coflux.dev/daemon). A path not ending in /client falls back to /daemon.
 */
export function daemonServerUrl(clientServerUrl: string): string {
  const url = new URL(clientServerUrl);
  url.pathname = url.pathname.endsWith("/client") ? `${url.pathname.slice(0, -"/client".length)}/daemon` : "/daemon";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Extract the token from `<publicUrl>/authorize/<token>` (the server encodes it with encodeURIComponent).
 * Deliberately shape-agnostic: the local pending-auth path relies on that; stricter checks live with callers.
 */
export function authorizeTokenFromUrl(url: string): string | null {
  try {
    const match = /\/authorize\/([^/?#]+)\/?$/.exec(new URL(url).pathname);
    if (!match) return null;
    const token = decodeURIComponent(match[1]);
    return token ? token : null;
  } catch {
    return null;
  }
}
