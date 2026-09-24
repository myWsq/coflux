/**
 * What "this machine" means to a built-in browser tab (plan 20260924-desktop-browser-tab).
 *
 * In a browser tab, `localhost`, `*.localhost`, all of `127.0.0.0/8`, `[::1]` and the unspecified
 * addresses `0.0.0.0` / `[::]` mean *the device the tab's workspace lives on*. The main process uses
 * this to block loopback requests of a remote workspace's partition (every resource type), and the
 * address bar uses the same rule to explain the block before navigating. One module, shared by both
 * sides, so the two can never disagree.
 *
 * Pure: no Electron, no DOM. Hostnames are expected in the form `URL` normalises them to (lowercase,
 * IPv4 shorthand expanded, IPv6 bracketed and compressed); anything else is still classified
 * conservatively rather than trusted.
 */

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. Accepts an embedded IPv4 tail. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return null;
  // An embedded IPv4 tail ("::ffff:127.0.0.1") is rewritten as its two hex groups first.
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1]!);
  if (!rest) return null;
  const known = head.length + rest.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

function isLoopbackIpv4(octets: readonly number[]): boolean {
  return octets[0] === 127 || octets.every((octet) => octet === 0);
}

function isLoopbackIpv6(groups: readonly number[]): boolean {
  const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
  if (!firstFiveZero) return false;
  const sixth = groups[5]!;
  const high = groups[6]!;
  const low = groups[7]!;
  // ::1 (loopback) and :: (unspecified).
  if (sixth === 0 && high === 0 && (low === 1 || low === 0)) return true;
  // ::ffff:127.x.y.z / ::ffff:0.0.0.0 (IPv4-mapped) and the deprecated ::127.x.y.z (IPv4-compatible).
  if (sixth === 0xffff || sixth === 0) {
    const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];
    return isLoopbackIpv4(octets);
  }
  return false;
}

/** A hostname (bracketed IPv6 allowed) that means "this machine" to whoever resolves it. */
export function isLoopbackHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = parseIpv4(host);
  if (v4) return isLoopbackIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isLoopbackIpv6(v6);
  return false;
}

/** Whether a URL's host is a loopback host. Unparseable URLs are not loopback (they cannot be requested). */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return isLoopbackHost(parsed.hostname);
}
