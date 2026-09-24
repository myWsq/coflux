/**
 * Built-in browser tabs' stored records (plan 20260924-desktop-browser-tab).
 *
 * A browser tab is a layout entry (terminal-layout.ts, `BROWSER_TAB_PREFIX`); what it shows lives
 * here: its workspace, its URL and its last title, keyed by tab id. Records are written no later
 * than the layout that references them, and on restore a browser id in a layout without a record
 * is dropped, as is a record no layout references. Local to this machine and scoped by server
 * address like the layouts — never synced to the account.
 *
 * Pure: storage is injected, as for the layout and the ⌘P recent-places store.
 */

import { isBrowsableUrl } from "./browser-address";
import { BROWSER_TAB_PREFIX, browserTabIdsOf, pruneBrowserTabs, type TerminalLayout } from "./terminal-layout";

export type BrowserTabRecord = {
  workspaceId: string;
  /** The page's URL; empty for a blank new tab. Only http(s) and about:blank are ever stored. */
  url: string;
  /** Last page title seen; empty when there was none. */
  title: string;
};

export type BrowserTabRecords = Readonly<Record<string, BrowserTabRecord>>;

export type BrowserTabStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
/** More than anyone keeps open; a guard against a corrupted or runaway value, not a product limit. */
const MAX_RECORDS = 500;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 8192;

/** A fresh browser tab id. `unique` is any string unique enough on this machine (a UUID in the app). */
export function createBrowserTabId(unique: string): string {
  return `${BROWSER_TAB_PREFIX}${unique.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return "";
  return isBrowsableUrl(value) ? value : "";
}

function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TITLE_LENGTH) : "";
}

/** Parses a stored value; anything unusable reads as "nothing stored", a bad entry is skipped. */
export function parseBrowserTabRecords(raw: string | null): Record<string, BrowserTabRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.tabs)) return {};
  const records: Record<string, BrowserTabRecord> = {};
  let count = 0;
  for (const [id, value] of Object.entries(parsed.tabs)) {
    if (count >= MAX_RECORDS) break;
    if (!id.startsWith(BROWSER_TAB_PREFIX) || id.length > 128 || !isRecord(value)) continue;
    if (typeof value.workspaceId !== "string" || value.workspaceId.length === 0) continue;
    records[id] = { workspaceId: value.workspaceId, url: cleanUrl(value.url), title: cleanTitle(value.title) };
    count += 1;
  }
  return records;
}

export function serializeBrowserTabRecords(records: BrowserTabRecords): string {
  const tabs: Record<string, BrowserTabRecord> = {};
  for (const id of Object.keys(records).sort()) {
    const record = records[id]!;
    tabs[id] = { workspaceId: record.workspaceId, url: cleanUrl(record.url), title: cleanTitle(record.title) };
  }
  return JSON.stringify({ version: STORAGE_VERSION, tabs });
}

/** Storage that throws or holds junk reads as "nothing stored". */
export function readBrowserTabRecords(store: BrowserTabStore): Record<string, BrowserTabRecord> {
  try {
    return parseBrowserTabRecords(store.storage.getItem(store.key));
  } catch {
    return {};
  }
}

/** Best-effort write; a tab that cannot be remembered is not worth an error. */
export function writeBrowserTabRecords(store: BrowserTabStore, serialized: string): boolean {
  try {
    store.storage.setItem(store.key, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cold start: keeps the browser tabs that have both a layout entry and a record for the same
 * workspace, drops the rest from either side. Layouts that did not change are returned as the same
 * objects.
 */
export function restoreBrowserTabs(
  layouts: Readonly<Record<string, TerminalLayout>>,
  records: BrowserTabRecords,
): { layouts: Record<string, TerminalLayout>; records: Record<string, BrowserTabRecord> } {
  const nextLayouts: Record<string, TerminalLayout> = {};
  const nextRecords: Record<string, BrowserTabRecord> = {};
  for (const [workspaceId, layout] of Object.entries(layouts)) {
    const pruned = pruneBrowserTabs(layout, (id) => records[id]?.workspaceId === workspaceId);
    nextLayouts[workspaceId] = pruned;
    for (const id of browserTabIdsOf(pruned)) nextRecords[id] = records[id]!;
  }
  return { layouts: nextLayouts, records: nextRecords };
}
