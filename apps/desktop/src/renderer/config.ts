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
/**
 * Whether the workbench sidebar is collapsed (plan 20260930-collapsible-sidebar). Separate from the
 * width, which the settings page's column shares and which must survive a collapse; unscoped like
 * the width, a per-machine UI preference.
 */
export const SIDEBAR_COLLAPSED_KEY = "coflux_sidebar_collapsed";
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
 * Remote screen tabs' records (plan 20260929-remote-desktop): per tab, its workspace, device and
 * remote session id. Scoped like the layouts that reference them.
 */
export const SCREEN_TABS_KEY = `coflux_screen_tabs:${SERVER_URL}`;
/**
 * The remote screen's resolution choice per device (plan 20261011-screen-resolution-presets): a
 * fixed preset in points, or nothing for 「跟随窗口」. Scoped by server address like the screen tab
 * records — device ids mean nothing on another server.
 */
export const SCREEN_RESOLUTIONS_KEY = `coflux_screen_resolutions:${SERVER_URL}`;
/**
 * File tabs' records (plan 20261001-terminal-file-tab): per tab, its workspace, the file's canonical
 * workspace-relative path and the line it was opened at. Scoped like the layouts that reference
 * them; never synced to the account.
 */
export const FILE_TABS_KEY = `coflux_file_tabs:${SERVER_URL}`;
/**
 * The built-in browser's history: global on this Mac — every workspace and every server share
 * it — and never synced.
 */
export const BROWSER_LIBRARY_KEY = "coflux_browser_library";
/**
 * Where 2.14.0 kept the agent launch settings on this Mac (plan 20261001-desktop-agents). They are
 * the account's now (plan 20261002-account-agent-settings); this key is only ever removed, never read.
 */
export const LEGACY_AGENT_SETTINGS_KEY = "coflux_agents";
/**
 * Which terminal tabs were opened as an agent (task id → agent id), for their tab icon. Scoped by
 * server address like the layouts: task ids mean nothing on another server.
 */
export const AGENT_TABS_KEY = `coflux_agent_tabs:${SERVER_URL}`;

export type { AuthCredential } from "@coflux/client";
