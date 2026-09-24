import { timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/**
 * The pure half of the browser tab's local proxy (plan 20260924-remote-localhost-tunnel): request
 * heads, their rewriting, body framing, proxy credentials, `resolveProxy` answers and the few bytes
 * of SOCKS5 and upstream CONNECT the proxy speaks. No sockets, no Electron.
 */

/** A request head larger than this is refused (Chromium's own limit for response heads is 256 KiB). */
export const MAX_HEAD_BYTES = 64 * 1024;

export type RequestHead = {
  method: string;
  target: string;
  version: string;
  /** In order, names as sent. */
  headers: Array<[string, string]>;
};

const CRLF_CRLF = Buffer.from("\r\n\r\n");

/** Where the head ends (index just past `\r\n\r\n`), or -1 while incomplete. */
export function headEnd(buffer: Buffer): number {
  const index = buffer.indexOf(CRLF_CRLF);
  return index < 0 ? -1 : index + 4;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseRequestHead(head: Buffer): RequestHead | null {
  const text = head.toString("latin1");
  const lines = text.split("\r\n");
  // A head ends with an empty line; `split` leaves two empty strings after the final CRLFCRLF.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const requestLine = lines.shift();
  if (!requestLine) return null;
  const parts = requestLine.split(" ");
  if (parts.length !== 3) return null;
  const [method, target, version] = parts as [string, string, string];
  if (!TOKEN.test(method) || !target || !/^HTTP\/1\.[01]$/.test(version)) return null;
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) return null;
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { method, target, version, headers };
}

export function headerValue(head: RequestHead, name: string): string | undefined {
  const lower = name.toLowerCase();
  return head.headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** `host:port` of a CONNECT target, brackets kept on IPv6 literals for display and classification. */
export type Authority = { host: string; port: number };

export function parseAuthority(value: string): Authority | null {
  const match = /^(\[[0-9A-Fa-f:.%]+\]|[^:[\]/\s]+):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1]!.toLowerCase(), port };
}

/** The host as a socket wants it: IPv6 literals without brackets. */
export function socketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** An absolute-form http target (`http://host:port/path?query`), as Chromium sends it to a proxy. */
export type AbsoluteTarget = { host: string; port: number; path: string; url: string };

export function parseAbsoluteTarget(target: string): AbsoluteTarget | null {
  if (!/^http:\/\//i.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !url.hostname || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : 80;
  // The origin form is sliced from the target as sent, never re-serialised: a dev server must see
  // exactly the path the page asked for. No fragment ever reaches a server.
  const rest = target.slice("http://".length);
  const pathStart = rest.search(/[/?#]/);
  let path = pathStart < 0 ? "/" : rest.slice(pathStart);
  const fragment = path.indexOf("#");
  if (fragment >= 0) path = path.slice(0, fragment);
  if (!path.startsWith("/")) path = `/${path}`;
  // `URL` keeps IPv6 hostnames bracketed.
  return { host: url.hostname.toLowerCase(), port, path, url: url.href };
}

/**
 * The head to send on: the request line in origin form when the next hop is the origin server (dev
 * servers route on `req.url` and break on absolute form), untouched when it is another proxy; our
 * own `Proxy-*` headers (credentials, `Proxy-Connection`) never leave.
 */
export function rewriteRequestHead(head: RequestHead, options: { originForm: string | null }): Buffer {
  const target = options.originForm ?? head.target;
  const lines = [`${head.method} ${target} ${head.version}`];
  for (const [name, value] of head.headers) {
    if (name.toLowerCase().startsWith("proxy-")) continue;
    lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export type BodyFraming = { kind: "none" } | { kind: "length"; length: number } | { kind: "chunked" } | { kind: "invalid" };

/** How the request body after this head is delimited (RFC 9112 §6.3, request side). */
export function requestBodyFraming(head: RequestHead): BodyFraming {
  const encodings = head.headers.filter(([name]) => name.toLowerCase() === "transfer-encoding").map(([, value]) => value.toLowerCase());
  if (encodings.length > 0) {
    const codings = encodings.join(",").split(",").map((value) => value.trim()).filter(Boolean);
    return codings[codings.length - 1] === "chunked" ? { kind: "chunked" } : { kind: "invalid" };
  }
  const lengths = head.headers.filter(([name]) => name.toLowerCase() === "content-length").map(([, value]) => value.trim());
  if (lengths.length === 0) return { kind: "none" };
  if (!lengths.every((value) => value === lengths[0]) || !/^\d{1,15}$/.test(lengths[0]!)) return { kind: "invalid" };
  const length = Number(lengths[0]);
  return length === 0 ? { kind: "none" } : { kind: "length", length };
}

/** A request that switches protocols: after its head the connection is an opaque byte stream. */
export function isUpgradeRequest(head: RequestHead): boolean {
  return headerValue(head, "upgrade") !== undefined && /\bupgrade\b/i.test(headerValue(head, "connection") ?? "");
}

/**
 * Finds where a chunked body ends without changing it: the bytes pass through as they are. Feed it
 * successive buffers; `scan` says how many bytes of each belong to the body and whether it ended.
 */
export class ChunkedScanner {
  private state: "size" | "data" | "data-crlf" | "trailer" = "size";
  private line = "";
  private remaining = 0;
  private done = false;

  /** Bytes of `buffer` that belong to the body, whether the body ended there, or an error. */
  scan(buffer: Buffer): { consumed: number; done: boolean } | { error: string } {
    let index = 0;
    while (index < buffer.length && !this.done) {
      if (this.state === "data") {
        const take = Math.min(this.remaining, buffer.length - index);
        index += take;
        this.remaining -= take;
        if (this.remaining === 0) this.state = "data-crlf";
        continue;
      }
      const byte = buffer[index++]!;
      if (byte !== 0x0a) {
        this.line += String.fromCharCode(byte);
        if (this.line.length > 4096) return { error: "chunk line too long" };
        continue;
      }
      if (!this.line.endsWith("\r")) return { error: "bare LF in chunked body" };
      const line = this.line.slice(0, -1);
      this.line = "";
      if (this.state === "size") {
        const size = /^([0-9A-Fa-f]{1,12})(?:[ \t]*;.*)?$/.exec(line);
        if (!size) return { error: "invalid chunk size" };
        this.remaining = Number.parseInt(size[1]!, 16);
        this.state = this.remaining === 0 ? "trailer" : "data";
      } else if (this.state === "data-crlf") {
        if (line !== "") return { error: "missing CRLF after chunk" };
        this.state = "size";
      } else if (line === "") {
        this.done = true;
      }
    }
    return { consumed: index, done: this.done };
  }
}

/* ------------------------------ proxy credentials ------------------------------ */

export type ProxyCredentials = { username: string; password: string };

export function basicAuthorization(credentials: ProxyCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

/** Constant-time check of a `Proxy-Authorization` value against the listener's own credentials. */
export function proxyAuthorized(value: string | undefined, credentials: ProxyCredentials): boolean {
  if (value === undefined) return false;
  const expected = Buffer.from(basicAuthorization(credentials));
  const actual = Buffer.from(value.trim());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const PROXY_AUTH_REQUIRED = Buffer.from(
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="coflux"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
);
export const CONNECT_ESTABLISHED = Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n");
/** Only ever an answer to CONNECT: Chromium reports it as a tunnel failure, never renders it. */
export const CONNECT_FAILED = Buffer.from("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

/* ------------------------------ system proxy ------------------------------ */

export type ProxyRoute =
  | { kind: "direct" }
  | { kind: "http"; host: string; port: number }
  | { kind: "https"; host: string; port: number }
  | { kind: "socks5"; host: string; port: number };

/**
 * `session.resolveProxy` answers in PAC form: `"PROXY host:port; SOCKS5 host:port; DIRECT"`. Every
 * entry this proxy can follow, in order; `SOCKS` (formally v4) is followed as SOCKS5, which every
 * system proxy that offers it speaks.
 */
export function parseProxyList(answer: string): ProxyRoute[] {
  const routes: ProxyRoute[] = [];
  for (const raw of answer.split(";")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [type = "", address = ""] = entry.split(/\s+/, 2);
    const kind = type.toUpperCase();
    if (kind === "DIRECT") {
      routes.push({ kind: "direct" });
      continue;
    }
    const authority = parseAuthority(address.toLowerCase());
    if (!authority) continue;
    const host = socketHost(authority.host);
    if (kind === "PROXY") routes.push({ kind: "http", host, port: authority.port });
    else if (kind === "HTTPS") routes.push({ kind: "https", host, port: authority.port });
    else if (kind === "SOCKS" || kind === "SOCKS5") routes.push({ kind: "socks5", host, port: authority.port });
  }
  return routes;
}

/** The first route this proxy supports; DIRECT when the answer names none (or nothing at all). */
export function pickProxyRoute(answer: string): ProxyRoute {
  return parseProxyList(answer)[0] ?? { kind: "direct" };
}

/** The URL `resolveProxy` is asked about for a CONNECT target. */
export function connectProbeUrl(authority: Authority): string {
  return `https://${authority.host}:${authority.port}/`;
}

/* ------------------------------ SOCKS5 and upstream CONNECT ------------------------------ */

export const SOCKS5_GREETING = Buffer.from([0x05, 0x01, 0x00]);

/** The CONNECT request of SOCKS5 (RFC 1928 §4): IP literals as addresses, names as domain names. */
export function socks5ConnectRequest(host: string, port: number): Buffer {
  const bare = socketHost(host);
  let address: Buffer;
  if (isIPv4(bare)) address = Buffer.from([0x01, ...bare.split(".").map(Number)]);
  else if (isIPv6(bare)) address = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(bare)]);
  else {
    const name = Buffer.from(bare, "utf8");
    if (name.length === 0 || name.length > 255) throw new Error("SOCKS5 host name length");
    address = Buffer.concat([Buffer.from([0x03, name.length]), name]);
  }
  const portBytes = Buffer.from([port >> 8, port & 0xff]);
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBytes]);
}

function ipv6Bytes(address: string): Buffer {
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const headGroups = groups(head);
  const tailGroups = groups(tail);
  const expanded = address.includes("::")
    ? [...headGroups, ...new Array<string>(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups]
    : headGroups;
  const bytes = Buffer.alloc(16);
  expanded.slice(0, 8).forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2));
  return bytes;
}

/**
 * Length of a complete SOCKS5 reply at the start of `buffer`, or 0 while incomplete; throws when the
 * proxy refused. The reply's bound address is of no use here.
 */
export function socks5ReplyLength(buffer: Buffer): number {
  if (buffer.length < 5) return 0;
  if (buffer[0] !== 0x05) throw new Error("not a SOCKS5 reply");
  if (buffer[1] !== 0x00) throw new Error(`SOCKS5 connect refused (${buffer[1]})`);
  const type = buffer[3];
  const addressLength = type === 0x01 ? 4 : type === 0x04 ? 16 : type === 0x03 ? 1 + buffer[4]! : -1;
  if (addressLength < 0) throw new Error("SOCKS5 reply address type");
  const total = 4 + addressLength + 2;
  return buffer.length >= total ? total : 0;
}

export function upstreamConnectRequest(authority: Authority): Buffer {
  const target = `${authority.host}:${authority.port}`;
  return Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, "latin1");
}

/** The status code of an upstream proxy's answer to CONNECT, or null when the head is malformed. */
export function connectResponseStatus(head: Buffer): number | null {
  const match = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(head.toString("latin1"));
  return match ? Number(match[1]) : null;
}
