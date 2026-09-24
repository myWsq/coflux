import { randomBytes } from "node:crypto";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import { isLoopbackHost } from "../shared/browser-loopback";
import {
  CONNECT_ESTABLISHED,
  CONNECT_FAILED,
  ChunkedScanner,
  connectProbeUrl,
  connectResponseStatus,
  headEnd,
  headerValue,
  isUpgradeRequest,
  MAX_HEAD_BYTES,
  parseAbsoluteTarget,
  parseAuthority,
  parseRequestHead,
  pickProxyRoute,
  PROXY_AUTH_REQUIRED,
  proxyAuthorized,
  requestBodyFraming,
  rewriteRequestHead,
  socketHost,
  SOCKS5_GREETING,
  socks5ConnectRequest,
  socks5ReplyLength,
  upstreamConnectRequest,
  type Authority,
  type ProxyCredentials,
  type ProxyRoute,
  type RequestHead,
} from "./browser-proxy-protocol";
import { TunnelError, type TunnelFailureReason } from "./loopback-tunnel";

/**
 * The local proxy of one remote workspace's browser partition (plan 20260924-remote-localhost-tunnel).
 *
 * Chromium sends every request of that partition here (`fixed_servers` + `<-loopback>`): CONNECT for
 * https, wss and ws, absolute-form requests for plain http. Loopback targets (`localhost`, `*.localhost`,
 * `127.0.0.0/8`, `[::1]`, `0.0.0.0`, `[::]` — slice 1's shared classifier) go through the device
 * tunnel, so the page keeps the exact URL and Origin it has on the device; everything else leaves
 * from this Mac along its system proxy settings, as in any browser.
 *
 * Private and authenticated: bound to 127.0.0.1 on an ephemeral port, one listener per partition
 * (the port is the routing key), random Basic credentials answered to Chromium from the app's
 * `login` event. A request without them gets 407.
 *
 * A plain-http request whose tunnel cannot be opened gets no answer at all — the connection is
 * dropped, so Chromium fails the load and the renderer shows its own page; a proxy-made body would be
 * rendered as the page. CONNECT failures answer 502, which Chromium reports as a tunnel failure.
 * Bodies stream both ways; nothing is buffered whole.
 */

const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

export type PartitionProxyOptions = {
  /** A connection to the device's loopback port; rejects with a `TunnelError`. */
  connectLoopback(port: number): Promise<Duplex>;
  /** This Mac's system proxy for a URL, in PAC form (`session.defaultSession.resolveProxy`). */
  resolveProxy(url: string): Promise<string>;
  /** Every loopback open's outcome, for the failure page the renderer asks about. */
  onLoopbackResult(port: number, failure: TunnelFailureReason | null): void;
  log(message: string, detail?: unknown): void;
};

export type PartitionProxy = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly credentials: ProxyCredentials;
  close(): void;
};

export async function startPartitionProxy(options: PartitionProxyOptions): Promise<PartitionProxy> {
  const credentials: ProxyCredentials = { username: "coflux", password: randomBytes(24).toString("hex") };
  const connections = new Set<ProxyConnection>();
  const server: Server = createServer({ noDelay: true }, (socket) => {
    const connection = new ProxyConnection(socket, credentials, options, () => connections.delete(connection));
    connections.add(connection);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => options.log("浏览器代理监听出错", String(error)));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("浏览器代理没有拿到端口");
  }
  let closed = false;
  return {
    host: "127.0.0.1",
    port: address.port,
    credentials,
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
      for (const connection of [...connections]) connection.close();
      connections.clear();
    },
  };
}

type Upstream = { key: string; stream: Duplex; alive: boolean; detach(): void };

function reasonOf(error: unknown): TunnelFailureReason {
  return error instanceof TunnelError ? error.reason : "offline";
}

/** One Chromium connection to the proxy: a sequence of requests, or one CONNECT tunnel. */
class ProxyConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private phase: "head" | "body" | "busy" | "raw" | "closed" = "head";
  private bodyRemaining = 0;
  private chunked: ChunkedScanner | null = null;
  private upstream: Upstream | null = null;
  private finished = false;
  /** Waiting for the upstream to drain: Chromium is not read meanwhile. */
  private draining = false;
  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.process();
  };

  constructor(
    private readonly client: Socket,
    private readonly credentials: ProxyCredentials,
    private readonly options: PartitionProxyOptions,
    private readonly onClosed: () => void,
  ) {
    client.on("data", this.onData);
    client.on("error", () => this.close());
    client.on("close", () => this.close());
  }

  close(): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = "closed";
    this.buffer = Buffer.alloc(0);
    const upstream = this.upstream;
    this.upstream = null;
    upstream?.detach();
    upstream?.stream.destroy();
    this.client.destroy();
    this.onClosed();
  }

  private process(): void {
    while (this.phase !== "closed") {
      if (this.phase === "busy") return;
      if (this.phase === "raw") {
        if (this.buffer.length > 0) this.toUpstream(this.takeAll());
        return;
      }
      if (this.phase === "body") {
        if (this.buffer.length === 0) return;
        if (!this.forwardBody()) return;
        continue;
      }
      const end = headEnd(this.buffer);
      if (end < 0) {
        if (this.buffer.length > MAX_HEAD_BYTES) this.close();
        return;
      }
      if (end > MAX_HEAD_BYTES) {
        this.close();
        return;
      }
      const head = parseRequestHead(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end);
      if (!head) {
        this.close();
        return;
      }
      if (!proxyAuthorized(headerValue(head, "proxy-authorization"), this.credentials)) {
        // Chromium asks the app's `login` handler, then retries with credentials on a new connection.
        // The socket's own close finishes this connection.
        this.phase = "closed";
        this.client.off("data", this.onData);
        this.client.end(PROXY_AUTH_REQUIRED);
        return;
      }
      if (head.method.toUpperCase() === "CONNECT") void this.tunnel(head);
      else void this.forward(head);
      return;
    }
  }

  private takeAll(): Buffer {
    const bytes = this.buffer;
    this.buffer = Buffer.alloc(0);
    return bytes;
  }

  /** Streams request-body bytes on; false while waiting. Returns to head parsing when it ended. */
  private forwardBody(): boolean {
    if (this.chunked) {
      const result = this.chunked.scan(this.buffer);
      if ("error" in result) {
        this.close();
        return false;
      }
      this.toUpstream(this.buffer.subarray(0, result.consumed));
      this.buffer = this.buffer.subarray(result.consumed);
      if (result.done) {
        this.chunked = null;
        this.phase = "head";
      }
      return true;
    }
    const take = Math.min(this.bodyRemaining, this.buffer.length);
    this.toUpstream(this.buffer.subarray(0, take));
    this.buffer = this.buffer.subarray(take);
    this.bodyRemaining -= take;
    if (this.bodyRemaining === 0) this.phase = "head";
    return true;
  }

  private toUpstream(bytes: Buffer): void {
    const upstream = this.upstream;
    if (!upstream || bytes.length === 0) return;
    if (!upstream.stream.write(bytes) && !this.draining) {
      // Stop reading Chromium until the upstream drains: bodies are streamed, never buffered whole.
      this.draining = true;
      this.client.pause();
      upstream.stream.once("drain", () => {
        this.draining = false;
        if (this.upstream === upstream && this.phase !== "closed" && this.phase !== "busy") this.client.resume();
      });
    }
  }

  private busy(): void {
    this.phase = "busy";
    this.client.pause();
  }

  private resume(phase: "head" | "body" | "raw"): void {
    if (this.phase === "closed") return;
    this.phase = phase;
    if (!this.draining) this.client.resume();
    this.process();
  }

  /** Opens the next hop for a loopback target (device tunnel) or any other (system proxy). */
  private async open(target: Authority, route: ProxyRoute | null, mode: "connect" | "plain"): Promise<Duplex> {
    if (route === null) {
      try {
        const stream = await this.options.connectLoopback(target.port);
        this.options.onLoopbackResult(target.port, null);
        return stream;
      } catch (error) {
        this.options.onLoopbackResult(target.port, reasonOf(error));
        throw error;
      }
    }
    return openRoute(route, target, mode);
  }

  private async tunnel(head: RequestHead): Promise<void> {
    this.busy();
    const authority = parseAuthority(head.target);
    if (!authority) {
      this.failConnect();
      return;
    }
    let stream: Duplex;
    try {
      const route = isLoopbackHost(authority.host) ? null : pickProxyRoute(await this.options.resolveProxy(connectProbeUrl(authority)));
      stream = await this.open(authority, route, "connect");
    } catch {
      this.failConnect();
      return;
    }
    if (this.phase === "closed") {
      stream.destroy();
      return;
    }
    this.client.write(CONNECT_ESTABLISHED);
    this.client.off("data", this.onData);
    const early = this.takeAll();
    this.phase = "raw";
    splice(this.client, stream, early);
    // Kept for close(): an abrupt end of the Chromium side tears the tunnel down.
    this.upstream = { key: "connect", stream, alive: true, detach: () => undefined };
  }

  private async forward(head: RequestHead): Promise<void> {
    this.busy();
    const target = parseAbsoluteTarget(head.target);
    const framing = requestBodyFraming(head);
    if (!target || framing.kind === "invalid") {
      this.close();
      return;
    }
    const authority: Authority = { host: target.host, port: target.port };
    let route: ProxyRoute | null = null;
    let key: string;
    let originForm: string | null = target.path;
    if (isLoopbackHost(target.host)) {
      key = `tunnel:${target.port}`;
    } else {
      try {
        route = pickProxyRoute(await this.options.resolveProxy(target.url));
      } catch {
        route = { kind: "direct" };
      }
      if (route.kind === "http" || route.kind === "https") {
        // Another proxy takes absolute form, for any host: one connection to it serves them all.
        key = `${route.kind}:${route.host}:${route.port}`;
        originForm = null;
      } else if (route.kind === "socks5") {
        key = `socks5:${route.host}:${route.port}:${target.host}:${target.port}`;
      } else {
        key = `direct:${target.host}:${target.port}`;
      }
    }
    if (this.phase === "closed") return;
    if (!this.upstream || this.upstream.key !== key || !this.upstream.alive) {
      const previous = this.upstream;
      this.upstream = null;
      this.draining = false;
      previous?.detach();
      previous?.stream.destroy();
      let stream: Duplex;
      try {
        stream = await this.open(authority, route, "plain");
      } catch {
        // Never an HTTP answer here: Chromium would render it as the page. Dropping the connection
        // makes the load fail, and the renderer asks main why.
        this.close();
        return;
      }
      if (this.phase === "closed") {
        stream.destroy();
        return;
      }
      this.upstream = this.attach(key, stream);
    }
    this.toUpstream(rewriteRequestHead(head, { originForm }));
    if (isUpgradeRequest(head)) {
      this.resume("raw");
      return;
    }
    if (framing.kind === "length") {
      this.bodyRemaining = framing.length;
      this.resume("body");
    } else if (framing.kind === "chunked") {
      this.chunked = new ChunkedScanner();
      this.resume("body");
    } else {
      this.resume("head");
    }
  }

  /** Responses stream back as they come; the next request may reuse this upstream (keep-alive). */
  private attach(key: string, stream: Duplex): Upstream {
    const upstream: Upstream = { key, stream, alive: true, detach: () => undefined };
    let waitingDrain = false;
    const onData = (chunk: Buffer) => {
      if (this.upstream !== upstream) return;
      if (!this.client.write(chunk) && !waitingDrain) {
        waitingDrain = true;
        stream.pause();
        this.client.once("drain", () => {
          waitingDrain = false;
          stream.resume();
        });
      }
    };
    // The origin closed the connection: so does the proxy's, which also ends a response delimited
    // by close. Chromium opens a new proxy connection for its next request.
    const onEnd = () => {
      upstream.alive = false;
      if (this.upstream === upstream && this.phase !== "closed") this.client.end();
    };
    const onClose = () => {
      upstream.alive = false;
      if (this.upstream === upstream && !this.client.writableEnded) this.close();
    };
    const onError = () => {
      upstream.alive = false;
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
    // A socket that came back from a SOCKS5 or CONNECT handshake is explicitly paused.
    stream.resume();
    upstream.detach = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      // Keep an error listener: a detached stream being destroyed must not throw.
    };
    return upstream;
  }

  /** A failed CONNECT: 502 (reported by Chromium as a tunnel failure), then close. */
  private failConnect(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.client.off("data", this.onData);
    this.client.end(CONNECT_FAILED);
  }
}

/** Joins two byte streams both ways; a graceful end is passed on, an abrupt close tears both down. */
function splice(client: Socket, stream: Duplex, early: Buffer): void {
  if (early.length > 0) stream.write(early);
  client.pipe(stream);
  stream.pipe(client);
  const ignore = () => undefined;
  client.on("error", ignore);
  stream.on("error", ignore);
  stream.on("close", () => {
    // After a graceful end the pipe already ended the client; let it flush.
    if (!client.writableEnded) client.destroy();
  });
  client.on("close", () => {
    if (!stream.writableEnded) stream.destroy();
  });
  client.resume();
}

function withTimeout<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("upstream timed out"));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function tcp(host: string, port: number): Promise<Socket> {
  const socket = netConnect({ host: socketHost(host), port, noDelay: true });
  return withTimeout(
    new Promise<Socket>((resolve, reject) => {
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    }),
    () => socket.destroy(),
  );
}

function tlsTo(host: string, port: number): Promise<Socket> {
  const socket = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] });
  return withTimeout(
    new Promise<Socket>((resolve, reject) => {
      socket.once("secureConnect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    }),
    () => socket.destroy(),
  );
}

/**
 * Reads from a fresh socket until `complete` finds a whole reply, then leaves the socket paused
 * with whatever followed the reply pushed back in front of its stream.
 */
function readReply(socket: Socket, complete: (buffer: Buffer) => number): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let length: number;
        try {
          length = complete(buffer);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (length === 0) {
          if (buffer.length > MAX_HEAD_BYTES) {
            cleanup();
            reject(new Error("upstream reply too long"));
          }
          return;
        }
        cleanup();
        socket.pause();
        if (length < buffer.length) socket.unshift(buffer.subarray(length));
        resolve(buffer.subarray(0, length));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("upstream closed"));
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    }),
    () => socket.destroy(),
  );
}

async function upstreamConnect(socket: Socket, target: Authority): Promise<Socket> {
  socket.write(upstreamConnectRequest(target));
  const head = await readReply(socket, headEnd);
  const status = connectResponseStatus(head);
  if (status === null || status < 200 || status > 299) throw new Error(`upstream proxy answered ${status ?? "garbage"}`);
  return socket;
}

async function socks5(socket: Socket, target: Authority): Promise<Socket> {
  socket.write(SOCKS5_GREETING);
  const greeting = await readReply(socket, (buffer) => (buffer.length >= 2 ? 2 : 0));
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error("SOCKS5 proxy wants authentication");
  socket.write(socks5ConnectRequest(target.host, target.port));
  await readReply(socket, socks5ReplyLength);
  return socket;
}

/** A connection to `target` along one system-proxy route. For `plain` over an HTTP(S) proxy, the proxy itself. */
async function openRoute(route: ProxyRoute, target: Authority, mode: "connect" | "plain"): Promise<Socket> {
  switch (route.kind) {
    case "direct":
      return tcp(target.host, target.port);
    case "socks5": {
      const socket = await tcp(route.host, route.port);
      try {
        return await socks5(socket, target);
      } catch (error) {
        socket.destroy();
        throw error;
      }
    }
    case "http":
    case "https": {
      const socket = route.kind === "http" ? await tcp(route.host, route.port) : await tlsTo(route.host, route.port);
      if (mode === "plain") return socket;
      try {
        return await upstreamConnect(socket, target);
      } catch (error) {
        socket.destroy();
        throw error;
      }
    }
  }
}
