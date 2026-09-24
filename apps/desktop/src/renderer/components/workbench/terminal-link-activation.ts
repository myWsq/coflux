/**
 * When a click on something link-like in a terminal counts as "open it".
 *
 * Web links (plan 20260924-desktop-browser-tab, replacing plan 109's ⌘ gate for them): a plain
 * primary click opens the URL in the system browser. xterm's Linkifier activates a link whenever
 * mousedown and mouseup land on the same link, with no look at modifiers, the button or the
 * selection — so a right click, a middle click and a drag-selection that starts and ends inside one
 * link would all "click" it. The rule therefore takes the button and whether the gesture left a
 * selection; the right click has its own menu (在系统浏览器中打开 / 在内置浏览器中打开 / 复制链接).
 *
 * File references (`src/a.ts:12:5`) are not web links and keep plan 109's gate: ⌘ (or Ctrl) + a
 * primary click copies the path.
 *
 * Pure and fed plain fields: the renderer's unit tests run under Node with no DOM, so nothing here
 * may touch a MouseEvent or window at runtime.
 */

/** The mouse event fields the rules read (a subset of MouseEvent, so it can be tested without a DOM). */
export type TerminalLinkClick = {
  metaKey?: boolean;
  ctrlKey?: boolean;
  /** MouseEvent.button: 0 is the primary button. Absent counts as primary. */
  button?: number;
};

function isPrimary(click: TerminalLinkClick): boolean {
  return click.button === undefined || click.button === 0;
}

/** A web link opens on a plain primary click — but never at the end of a drag that selected text. */
export function shouldOpenTerminalWebLink(click: TerminalLinkClick, hasSelection: boolean): boolean {
  return isPrimary(click) && !hasSelection;
}

/** A file reference is copied on ⌘/Ctrl + a primary click only. */
export function shouldCopyTerminalFileReference(click: TerminalLinkClick): boolean {
  return isPrimary(click) && (click.metaKey === true || click.ctrlKey === true);
}
