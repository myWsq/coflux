export const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;

// 独立命名空间：与桌面 web 同域调试时不串台（决策见 plan 032）。
export const TOKEN_KEY = "coflux_m_token";
export const BUILD_ID = __COFLUX_BUILD_ID__;

export type { AuthCredential } from "@coflux/client";
