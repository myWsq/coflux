/**
 * Main-process state that belongs to the renderer, reset when the renderer is rebuilt.
 *
 * ⌘R, a devtools reload and recovery after a renderer crash all destroy the page and build a new
 * one. The central `/client` WebSocket rides along — the renderer owns it, so destroying the
 * renderer re-handshakes it for free. Main-process state does **not**: it outlives the page, and the
 * new page has no reference to what the old one left behind. Two things go wrong without this:
 *
 *   - The native Tailcat transport is stranded. Its lanes, its helper subprocess and its control
 *     connection were opened on behalf of a page that no longer exists, and nothing will ever close
 *     them — lane quotas are per-process (256 records per lane, 1024 / 128 MB globally), so enough
 *     reloads and remote device connections start failing for reasons that look nothing like ⌘R.
 *   - The Dock badge freezes. The count lives in `notifications.ts` module scope while the fresh
 *     renderer starts its own mirror at 0 and only sends a count that *differs* from it, so a reload
 *     into a zero-badge state sends nothing and the Dock keeps the pre-reload number.
 *
 * The executor channel reset is hardening rather than a repair: today the renderer happens to send
 * `setExecutorChannel("")` before any daemon id on every mount, which is what keeps the host's
 * dedupe from swallowing the re-announcement. That protection lives in the renderer, not where it is
 * needed — the main process must not depend on renderer mount order for its own correctness.
 *
 * Deliberately *not* here: the executor job table. The runner lives in the main process and is
 * unaffected by the page going away; the resulting state must be exactly what a genuine channel drop
 * produces — the tasks keep running and reconciliation restores the state on reconnect.
 */

import { isTrustedRendererUrl } from "./ipc-trust";

/**
 * What a rebuilt renderer leaves behind. Every one of these must be a no-op when nothing is open,
 * because the very first `loadURL` fires the same event as a reload: `close()` on a transport with
 * no helper and no lanes, an empty channel id over an already empty one, and a zero badge over a
 * zero count are all naturally idempotent. That is the reason there is no "have we loaded once"
 * flag — such a flag is state that can desynchronise, and none is needed.
 */
export type RendererResetTargets = {
  /** Full close, not `pauseLanes()`: pausing deliberately keeps live session lanes open, and those
   * are precisely the lanes the destroyed renderer will never reference or close again. */
  closeTransport: () => void;
  /** Drop the executor device channel, leaving the job table alone. */
  resetExecutorChannel: () => void;
  setBadge: (count: number) => void;
  /**
   * Built-in browser tabs (plan 20260924-desktop-browser-tab): the rebuilt page destroyed every
   * `<webview>`, so the per-guest bookkeeping (guests, docked DevTools links, frozen screenshots) and
   * the partitions prepared for the old page go with it. Idempotent like the rest.
   */
  resetBrowserHost?: () => void;
};

/** A committed navigation of the window's own `webContents`. */
export type RendererNavigation = {
  url: string;
  isMainFrame: boolean;
  /** An in-page navigation (hash change, history API) keeps the document — nothing was rebuilt. */
  isSameDocument: boolean;
};

/**
 * Builds the listener for "this window's page was replaced".
 *
 * Hang it on `did-navigate`, never on `did-start-navigation`. An external link that `will-navigate`
 * cancels and hands to the system browser still fires `did-start-navigation` first — main-frame and
 * cross-document — so a reset hung there would tear the transport down while the page is not being
 * rebuilt at all, and it would fire *before* the commit, while the old document is still alive and
 * able to react to the resulting `closed` events by opening a lane that is then stranded in turn.
 * `did-navigate` fires after the commit and never fires for a cancelled navigation.
 *
 * The URL is still checked: `did-navigate` for anything but the app's own renderer means the page is
 * not the workbench, and tearing down main-process state for it would be resetting on behalf of
 * something that never owned it. Together with the two flags this is what keeps a
 * `did-start-navigation`-shaped event — should the wiring ever change — from resetting anything.
 */
export function createRendererResetListener(
  targets: RendererResetTargets,
  trusted: { appOrigin: string; devRendererUrl?: string },
): (navigation: RendererNavigation) => void {
  return (navigation) => {
    if (!navigation.isMainFrame || navigation.isSameDocument) return;
    if (!isTrustedRendererUrl(navigation.url, trusted)) return;
    targets.closeTransport();
    targets.resetExecutorChannel();
    targets.setBadge(0);
    targets.resetBrowserHost?.();
  };
}
