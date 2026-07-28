export const SERVER_URL =
  import.meta.env.VITE_COFLUX_SERVER ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;

export const TOKEN_KEY = "coflux_token";
export const BUILD_ID = __COFLUX_BUILD_ID__;
export const WORKSPACE_KEY = "coflux_workspace";
export const SIDEBAR_WIDTH_KEY = "coflux_sidebar_width";

export type { AuthCredential } from "@coflux/client";
