import { requireDesktopBridge } from "@/desktop-bridge";

/** 桥接必选（plan 106）：模块求值时就取，缺失即在渲染层启动期报错。 */
export const desktop = requireDesktopBridge();

// 自定义 scheme 下 location 没有可用 host：/client 地址与自报 Origin 都只来自 app 侧配置。
export const SERVER_URL = desktop.serverUrl;

/** 旧版把会话 token 明文放在 localStorage 的 key；现在只用于首次启动的一次性迁移（session-token.ts）。 */
export const LEGACY_TOKEN_KEY = "coflux_token";
export const BUILD_ID = __COFLUX_BUILD_ID__;
export const WORKSPACE_KEY = "coflux_workspace";
export const OPEN_WORKSPACES_KEY = "coflux_open_workspaces";
export const SIDEBAR_WIDTH_KEY = "coflux_sidebar_width";
/** 本机 daemon 接入引导点过「暂不」（plan 113）：按服务器地址分 key，之后只从账号菜单再进 */
export const DAEMON_ONBOARDING_DISMISSED_KEY = `coflux_daemon_onboarding_dismissed:${SERVER_URL}`;

export type { AuthCredential } from "@coflux/client";
