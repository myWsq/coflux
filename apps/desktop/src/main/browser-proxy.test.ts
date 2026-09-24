import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import test from "node:test";

import { startPartitionProxy, type PartitionProxy } from "./browser-proxy";
import { basicAuthorization } from "./browser-proxy-protocol";
import { TunnelError, type TunnelFailureReason } from "./loopback-tunnel";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** Reads from a raw socket until `predicate` holds for everything read so far. */
function readUntil(socket: Socket, predicate: (text: string) => boolean): Promise<string> {
  // A listener, not `for await`: leaving an async iterator early would destroy the socket.
  return new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (!predicate(text)) return;
      cleanup();
      resolve(text);
    };
    const onEnd = () => {
      cleanup();
      resolve(text);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
}

type Seen = { url: string | undefined; headers: IncomingHttpHeaders; body: string };

/** The "device": a dev server the fake tunnel reaches, plus a record of what the proxy asked for. */
async function fixture(options: { failWith?: TunnelFailureReason; resolveProxy?: (url: string) => Promise<string> } = {}) {
  const seen: Seen[] = [];
  const devServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.end(`served ${req.url}`);
    });
  });
  const devPort = await listen(devServer);
  const echo = createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const asked: number[] = [];
  const results: Array<[number, TunnelFailureReason | null]> = [];
  const proxy: PartitionProxy = await startPartitionProxy({
    connectLoopback: async (port) => {
      asked.push(port);
      if (options.failWith) throw new TunnelError(options.failWith, "test");
      const socket = connect(port === 443 ? echoPort : devPort, "127.0.0.1");
      await once(socket, "connect");
      return socket;
    },
    resolveProxy: options.resolveProxy ?? (async () => "DIRECT"),
    onLoopbackResult: (port, failure) => results.push([port, failure]),
    log: () => undefined,
  });
  const auth = basicAuthorization(proxy.credentials);
  const close = () => {
    proxy.close();
    devServer.closeAllConnections();
    devServer.close();
    echo.close();
  };
  return { proxy, auth, seen, asked, results, close };
}

function get(proxyPort: number, url: string, headers: Record<string, string>, agent?: Agent, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: body ? "POST" : "GET", path: url, headers: { Host: target.host, ...headers }, agent: agent ?? false },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("requests without the listener's credentials get 407 — plain and CONNECT alike", async () => {
  const f = await fixture();
  try {
    const plain = await get(f.proxy.port, "http://localhost:5173/", {});
    assert.equal(plain.status, 407);
    const socket = connect(f.proxy.port, "127.0.0.1");
    socket.write("CONNECT localhost:5173 HTTP/1.1\r\nHost: localhost:5173\r\nProxy-Authorization: Basic d3Jvbmc6d3Jvbmc=\r\n\r\n");
    const answer = await readUntil(socket, (text) => text.includes("\r\n\r\n"));
    assert.match(answer, /^HTTP\/1\.1 407 /);
    assert.match(answer, /Proxy-Authenticate: Basic realm="coflux"/);
    socket.destroy();
    assert.deepEqual(f.asked, [], "nothing reaches the device without credentials");
  } finally {
    f.close();
  }
});

test("plain http to loopback goes through the tunnel in origin form, keep-alive and bodies included", async () => {
  const f = await fixture();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await get(f.proxy.port, "http://localhost:5173/src/main.ts?t=1", { "Proxy-Authorization": f.auth, Origin: "http://localhost:5173" }, agent);
    assert.equal(first.text, "served /src/main.ts?t=1");
    const second = await get(f.proxy.port, "http://localhost:5173/api/save", { "Proxy-Authorization": f.auth }, agent, "x".repeat(200_000));
    assert.equal(second.text, "served /api/save");
    assert.equal(f.seen[0]!.url, "/src/main.ts?t=1");
    assert.equal(f.seen[0]!.headers.origin, "http://localhost:5173");
    assert.equal(f.seen[0]!.headers.host, "localhost:5173");
    assert.equal(f.seen[0]!.headers["proxy-authorization"], undefined);
    assert.equal(f.seen[1]!.body.length, 200_000);
    assert.deepEqual(f.asked, [5173], "the second request reused the tunnel connection");
    assert.deepEqual(f.results, [[5173, null]]);
  } finally {
    agent.destroy();
    f.close();
  }
});

test("a plain http tunnel failure drops the connection instead of answering, and is recorded", async () => {
  const f = await fixture({ failWith: "refused" });
  try {
    await assert.rejects(get(f.proxy.port, "http://localhost:5173/", { "Proxy-Authorization": f.auth }), /socket hang up|ECONNRESET/);
    assert.deepEqual(f.results, [[5173, "refused"]]);
  } finally {
    f.close();
  }
});

test("CONNECT to loopback splices onto the tunnel; a failure answers 502", async () => {
  const f = await fixture();
  try {
    const socket = connect(f.proxy.port, "127.0.0.1");
    socket.write(`CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\nProxy-Authorization: ${f.auth}\r\n\r\n`);
    const established = await readUntil(socket, (text) => text.includes("\r\n\r\n"));
    assert.match(established, /^HTTP\/1\.1 200 /);
    socket.write("ping over the tunnel");
    assert.equal(await readUntil(socket, (text) => text.includes("tunnel")), "ping over the tunnel");
    socket.destroy();
  } finally {
    f.close();
  }
  const failing = await fixture({ failWith: "unsupported" });
  try {
    const socket = connect(failing.proxy.port, "127.0.0.1");
    socket.write(`CONNECT [::1]:5173 HTTP/1.1\r\nHost: [::1]:5173\r\nProxy-Authorization: ${failing.auth}\r\n\r\n`);
    assert.match(await readUntil(socket, (text) => text.includes("\r\n\r\n")), /^HTTP\/1\.1 502 /);
    assert.deepEqual(failing.results, [[5173, "unsupported"]]);
    socket.destroy();
  } finally {
    failing.close();
  }
});

test("non-loopback traffic follows the system proxy: absolute form for plain http, CONNECT for tunnels", async () => {
  const upstreamSeen: string[] = [];
  const upstream = createServer((socket) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffered.slice(0, end);
      upstreamSeen.push(head);
      socket.off("data", onData);
      if (head.startsWith("CONNECT ")) {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        socket.pipe(socket);
      } else {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nupstream");
      }
    };
    socket.on("data", onData);
  });
  const upstreamPort = await listen(upstream);
  const asked: string[] = [];
  const f = await fixture({
    resolveProxy: async (url) => {
      asked.push(url);
      return `PROXY 127.0.0.1:${upstreamPort}; DIRECT`;
    },
  });
  try {
    const plain = await get(f.proxy.port, "http://example.test/page", { "Proxy-Authorization": f.auth });
    assert.equal(plain.text, "upstream");
    assert.match(upstreamSeen[0]!, /^GET http:\/\/example\.test\/page HTTP\/1\.1/);
    assert.doesNotMatch(upstreamSeen[0]!, /Proxy-Authorization/i, "our credentials never leave");

    const socket = connect(f.proxy.port, "127.0.0.1");
    socket.write(`CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${f.auth}\r\n\r\n`);
    assert.match(await readUntil(socket, (text) => text.includes("\r\n\r\n")), /^HTTP\/1\.1 200 /);
    socket.write("hello");
    assert.equal(await readUntil(socket, (text) => text.includes("hello")), "hello");
    socket.destroy();
    assert.match(upstreamSeen[1]!, /^CONNECT example\.test:443 HTTP\/1\.1/);
    assert.deepEqual(asked, ["http://example.test/page", "https://example.test:443/"]);
    assert.deepEqual(f.asked, [], "no loopback tunnel for other hosts");
  } finally {
    f.close();
    upstream.close();
  }
});
