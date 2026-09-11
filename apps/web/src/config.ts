import { getDesktopBridge, resolveServerUrl } from "@/desktop-bridge";

// 桌面 app（plan 103）下 location 是自定义 scheme，没有可用 host：地址由桥接给出；浏览器沿用同源推导。
export const SERVER_URL = resolveServerUrl({
  bridge: getDesktopBridge(),
  envServerUrl: import.meta.env.VITE_COFLUX_SERVER,
  location,
});

export const TOKEN_KEY = "coflux_token";
export const BUILD_ID = __COFLUX_BUILD_ID__;
export const WORKSPACE_KEY = "coflux_workspace";
export const SIDEBAR_WIDTH_KEY = "coflux_sidebar_width";

export type { AuthCredential } from "@coflux/client";
