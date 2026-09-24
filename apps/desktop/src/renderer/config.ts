import { requireDesktopBridge } from "@/desktop-bridge";

/** 桥接必选（plan 106）：模块求值时就取，缺失即在渲染层启动期报错。 */
export const desktop = requireDesktopBridge();

// 自定义 scheme 下 location 没有可用 host：/client 地址与自报 Origin 都只来自 app 侧配置。
export const SERVER_URL = desktop.serverUrl;

/** 旧版把会话 token 明文放在 localStorage 的 key；现在只用于首次启动的一次性迁移（session-token.ts）。 */
export const LEGACY_TOKEN_KEY = "coflux_token";
export const BUILD_ID = __COFLUX_BUILD_ID__;
export const WORKSPACE_KEY = "coflux_workspace";
export const SIDEBAR_WIDTH_KEY = "coflux_sidebar_width";
/** 本机 daemon 接入引导点过「暂不」（plan 113）：按服务器地址分 key，之后只从账号菜单再进 */
export const DAEMON_ONBOARDING_DISMISSED_KEY = `coflux_daemon_onboarding_dismissed:${SERVER_URL}`;
/**
 * Places the ⌘P palette lists under 「最近」 (plan 20260921). Scoped by server address, like the
 * onboarding flag and the offline catalogue: workspace / task / device ids mean nothing on
 * another server, and an unscoped key would make the palette offer places that do not exist.
 */
export const COMMAND_PALETTE_RECENT_KEY = `coflux_recent_places:${SERVER_URL}`;
/**
 * Terminal editor-group layouts per workspace (plan 20260923-terminal-split-groups): groups, tab
 * order, active tab per group, split ratios, focused group. Local to this machine and scoped by
 * server address like the palette's recent places — workspace and task ids mean nothing elsewhere.
 */
export const TERMINAL_LAYOUTS_KEY = `coflux_terminal_layouts:${SERVER_URL}`;
/**
 * Built-in browser tabs' records (plan 20260924-desktop-browser-tab): per tab, its workspace, URL
 * and last title. Scoped by server address exactly like the layouts that reference them.
 */
export const BROWSER_TABS_KEY = `coflux_browser_tabs:${SERVER_URL}`;
/**
 * The built-in browser's bookmarks, bookmarks-bar toggle and history: global on this Mac — every
 * workspace and every server share them — and never synced.
 */
export const BROWSER_LIBRARY_KEY = "coflux_browser_library";

export type { AuthCredential } from "@coflux/client";
