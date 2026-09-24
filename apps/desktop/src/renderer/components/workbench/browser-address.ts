/**
 * The built-in browser's address bar rules (plan 20260924-desktop-browser-tab).
 *
 * What the user typed becomes one of two things: a URL to load, or a web search. The rules follow
 * the product conclusions — a bare port is this workspace's `localhost` on that port, `host:port`
 * and hostnames get `http://`, a full http(s) URL is taken as it is, and anything that is not
 * URL-like is searched. `0.0.0.0` (and `[::]`) are rewritten to `localhost` everywhere a URL enters
 * the browser: recent Chromium refuses them as navigation targets, and the dev servers that print
 * them mean "listening on every interface", which includes loopback.
 *
 * Pure: no DOM, no Electron. The loopback set itself is shared with the main process.
 */

import { isLoopbackHost, isLoopbackUrl } from "../../../shared/browser-loopback";

export { isLoopbackHost, isLoopbackUrl };

/** New-tab search engine: Google, matching Cursor. */
export const SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

export type AddressResolution = { kind: "url"; url: string } | { kind: "search"; url: string; query: string };

/** The only URLs a browser tab ever loads: http(s), and about:blank for an empty page. */
export function isBrowsableUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isWebUrl(url: string): boolean {
  return url !== "about:blank" && isBrowsableUrl(url);
}

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * A forwarded port as a browser URL. Always `localhost`, never `127.0.0.1`: dev servers such as Vite
 * often bind `localhost` → `::1` only, which a hand-built `127.0.0.1` URL would miss.
 */
export function localPortUrl(port: number): string {
  return `http://localhost:${port}/`;
}

/** `0.0.0.0` / `[::]` → `localhost`, keeping everything else. Unparseable input comes back unchanged. */
export function rewriteUnspecifiedHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== "0.0.0.0" && parsed.hostname !== "[::]") return url;
  parsed.hostname = "localhost";
  return parsed.href;
}

export function searchUrl(query: string): string {
  return `${SEARCH_URL_PREFIX}${encodeURIComponent(query)}`;
}

function isDottedQuad(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** A domain-looking name: at least two labels, the last one alphabetic (a TLD) or punycode. */
function isDomainName(host: string): boolean {
  if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(host)) return false;
  const labels = host.split(".");
  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) return false;
  const tld = labels[labels.length - 1]!;
  return /^\p{L}{2,63}$/u.test(tld) || /^xn--[a-z0-9-]+$/i.test(tld);
}

/**
 * Whether `text` (no scheme) reads as `host[:port][/path…]`. Deliberately stricter than the URL
 * parser: `1.2` or `foo` must be searched, not turned into `http://1.0.0.2/` or `http://foo/`.
 */
function looksLikeHostAndPath(text: string): boolean {
  const authority = /^[^/?#]*/.exec(text)?.[0] ?? "";
  if (!authority || authority.includes("@")) return false;
  let host: string;
  let port = "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return false;
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
    port = rest.slice(1);
  } else {
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
    if (!match) return false;
    host = match[1]!.toLowerCase();
    port = match[2] ?? "";
  }
  if (port && !isValidPort(Number(port))) return false;
  if (host.startsWith("[")) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isDottedQuad(host)) return true;
  if (isDomainName(host)) return true;
  // A single-label name is a host only with an explicit port ("devbox:8080").
  return Boolean(port) && /^[\p{L}\p{N}-]+$/u.test(host);
}

/**
 * The address bar's decision. Empty input is nothing to do (null).
 * - a bare port (`5173`) → `http://localhost:5173/`
 * - a full `http(s)://` URL → as it is; `about:blank` → as it is
 * - `host:port`, a hostname or an IP, optionally with a path → `http://` + it
 * - anything else — spaces, single words, other schemes → a web search
 */
export function resolveAddressInput(input: string): AddressResolution | null {
  const text = input.trim();
  if (!text) return null;
  const search = (): AddressResolution => ({ kind: "search", url: searchUrl(text), query: text });

  if (/^\d{1,5}$/.test(text)) {
    const port = Number(text);
    return isValidPort(port) ? { kind: "url", url: localPortUrl(port) } : search();
  }
  if (text.toLowerCase() === "about:blank") return { kind: "url", url: "about:blank" };
  if (/\s/.test(text)) return search();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (!/^https?:\/\//i.test(text)) return search();
    try {
      const parsed = new URL(text);
      if (!parsed.hostname) return search();
      return { kind: "url", url: rewriteUnspecifiedHost(parsed.href) };
    } catch {
      return search();
    }
  }

  if (!looksLikeHostAndPath(text)) return search();
  try {
    return { kind: "url", url: rewriteUnspecifiedHost(new URL(`http://${text}`).href) };
  } catch {
    return search();
  }
}

/**
 * A URL that arrives from outside the address bar (a terminal link, a page popup, a bookmark):
 * http(s) only, with the unspecified host rewritten. Anything else is refused (null).
 */
export function normalizeIncomingUrl(url: string): string | null {
  const rewritten = rewriteUnspecifiedHost(url.trim());
  return isWebUrl(rewritten) ? rewritten : null;
}

/** What the tab strip shows before a page has a title: its host, or the URL itself. */
export function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

/** The address bar's resting text: the URL, without the trailing slash of a bare origin. */
export function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "";
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) return `${parsed.protocol}//${parsed.host}`;
    return parsed.href;
  } catch {
    return url;
  }
}

/** The port a loopback URL points at, for the error page's wording; null otherwise. */
export function loopbackPortOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) return null;
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : null;
  } catch {
    return null;
  }
}
