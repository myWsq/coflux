/**
 * Session partitions of the built-in browser (plan 20260924-desktop-browser-tab). Shared by the main
 * process (which prepares them and gates every `<webview>` on them) and the renderer (which only
 * uses the names main hands back, plus the DevTools host's fixed one).
 */

/**
 * Every workspace's pages live in their own persistent partition: cookies, storage and cache are
 * isolated per workspace (two worktrees on the same port keep separate logins) and survive restarts.
 */
export const BROWSER_PARTITION_PREFIX = "persist:coflux-browser-";

/**
 * The docked DevTools host: an in-memory partition of its own, recognised by name as the one guest
 * kind that may load `devtools://`. It never starts with the page prefix, so no workspace id can
 * produce it.
 */
export const BROWSER_DEVTOOLS_PARTITION = "coflux-browser-devtools";
