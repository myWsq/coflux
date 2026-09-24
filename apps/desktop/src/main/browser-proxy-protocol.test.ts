import assert from "node:assert/strict";
import test from "node:test";

import {
  basicAuthorization,
  ChunkedScanner,
  connectProbeUrl,
  connectResponseStatus,
  headEnd,
  headerValue,
  isUpgradeRequest,
  parseAbsoluteTarget,
  parseAuthority,
  parseProxyList,
  parseRequestHead,
  pickProxyRoute,
  proxyAuthorized,
  requestBodyFraming,
  rewriteRequestHead,
  socks5ConnectRequest,
  socks5ReplyLength,
  upstreamConnectRequest,
} from "./browser-proxy-protocol";

const head = (text: string) => {
  const parsed = parseRequestHead(Buffer.from(text, "latin1"));
  assert(parsed, `parses: ${JSON.stringify(text)}`);
  return parsed;
};

test("request heads: absolute form, CONNECT, and garbage", () => {
  const raw = Buffer.from("GET http://localhost:5173/src/main.ts?t=1 HTTP/1.1\r\nHost: localhost:5173\r\nProxy-Connection: keep-alive\r\n\r\nBODY");
  const end = headEnd(raw);
  assert.equal(raw.subarray(end).toString(), "BODY");
  const get = parseRequestHead(raw.subarray(0, end))!;
  assert.equal(get.method, "GET");
  assert.equal(get.target, "http://localhost:5173/src/main.ts?t=1");
  assert.equal(headerValue(get, "host"), "localhost:5173");
  assert.equal(headEnd(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n")), -1);

  const connect = head("CONNECT localhost:5173 HTTP/1.1\r\nHost: localhost:5173\r\n\r\n");
  assert.deepEqual(parseAuthority(connect.target), { host: "localhost", port: 5173 });
  assert.deepEqual(parseAuthority("[::1]:3000"), { host: "[::1]", port: 3000 });
  assert.deepEqual(parseAuthority("Example.COM:443"), { host: "example.com", port: 443 });
  assert.equal(parseAuthority("localhost"), null);
  assert.equal(parseAuthority("localhost:0"), null);
  assert.equal(parseAuthority("localhost:70000"), null);

  assert.equal(parseRequestHead(Buffer.from("GET /\r\n\r\n")), null);
  assert.equal(parseRequestHead(Buffer.from("GET / HTTP/2\r\n\r\n")), null);
  assert.equal(parseRequestHead(Buffer.from("GET / HTTP/1.1\r\nno colon\r\n\r\n")), null);
});

test("absolute-form targets become origin form exactly as sent", () => {
  assert.deepEqual(parseAbsoluteTarget("http://localhost:5173/src/App.tsx?import&t=17"), {
    host: "localhost",
    port: 5173,
    path: "/src/App.tsx?import&t=17",
    url: "http://localhost:5173/src/App.tsx?import&t=17",
  });
  assert.equal(parseAbsoluteTarget("http://localhost:3000")!.path, "/");
  assert.equal(parseAbsoluteTarget("http://localhost:3000?x=1")!.path, "/?x=1");
  assert.equal(parseAbsoluteTarget("http://example.com/a%20b/../c")!.path, "/a%20b/../c");
  assert.equal(parseAbsoluteTarget("http://example.com/")!.port, 80);
  assert.equal(parseAbsoluteTarget("http://[::1]:8080/x")!.host, "[::1]");
  assert.equal(parseAbsoluteTarget("/relative"), null);
  assert.equal(parseAbsoluteTarget("https://example.com/"), null);
  assert.equal(parseAbsoluteTarget("http://user:pass@example.com/"), null);
});

test("rewriting drops every Proxy-* header and keeps the rest in order", () => {
  const request = head(
    "POST http://localhost:5173/api HTTP/1.1\r\nHost: localhost:5173\r\nProxy-Authorization: Basic abc\r\nProxy-Connection: keep-alive\r\nOrigin: http://localhost:5173\r\nContent-Length: 2\r\n\r\n",
  );
  assert.equal(
    rewriteRequestHead(request, { originForm: "/api" }).toString(),
    "POST /api HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\nContent-Length: 2\r\n\r\n",
  );
  // Towards another proxy the absolute form stays.
  assert.equal(
    rewriteRequestHead(request, { originForm: null }).toString().split("\r\n")[0],
    "POST http://localhost:5173/api HTTP/1.1",
  );
});

test("request body framing", () => {
  assert.deepEqual(requestBodyFraming(head("GET http://a/ HTTP/1.1\r\n\r\n")), { kind: "none" });
  assert.deepEqual(requestBodyFraming(head("POST http://a/ HTTP/1.1\r\nContent-Length: 0\r\n\r\n")), { kind: "none" });
  assert.deepEqual(requestBodyFraming(head("POST http://a/ HTTP/1.1\r\nContent-Length: 12\r\n\r\n")), { kind: "length", length: 12 });
  assert.deepEqual(requestBodyFraming(head("POST http://a/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n")), { kind: "chunked" });
  assert.deepEqual(requestBodyFraming(head("POST http://a/ HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n")), { kind: "invalid" });
  assert.deepEqual(requestBodyFraming(head("POST http://a/ HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n")), { kind: "invalid" });
  assert.equal(isUpgradeRequest(head("GET http://a/ HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")), true);
  assert.equal(isUpgradeRequest(head("GET http://a/ HTTP/1.1\r\nUpgrade: websocket\r\n\r\n")), false);
});

test("chunked bodies are delimited without being changed, across any split", () => {
  const body = Buffer.from("4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nTrailer: x\r\n\r\n");
  const next = Buffer.from("GET http://a/ HTTP/1.1\r\n\r\n");
  const whole = Buffer.concat([body, next]);
  for (let split = 0; split <= whole.length; split++) {
    const scanner = new ChunkedScanner();
    const first = scanner.scan(whole.subarray(0, split));
    assert(!("error" in first));
    let consumed = first.consumed;
    let done = first.done;
    if (!done) {
      const second = scanner.scan(whole.subarray(split));
      assert(!("error" in second));
      consumed += second.consumed;
      done = second.done;
    }
    assert.equal(done, true, `split at ${split}`);
    assert.equal(consumed, body.length, `split at ${split}`);
  }
  assert("error" in new ChunkedScanner().scan(Buffer.from("zz\r\n")));
  assert("error" in new ChunkedScanner().scan(Buffer.from("1\r\nab\r\n")));
});

test("proxy credentials are the listener's own, compared exactly", () => {
  const credentials = { username: "coflux", password: "s3cret" };
  const value = basicAuthorization(credentials);
  assert.equal(value, `Basic ${Buffer.from("coflux:s3cret").toString("base64")}`);
  assert.equal(proxyAuthorized(value, credentials), true);
  assert.equal(proxyAuthorized(` ${value} `, credentials), true);
  assert.equal(proxyAuthorized(undefined, credentials), false);
  assert.equal(proxyAuthorized(basicAuthorization({ username: "coflux", password: "other!" }), credentials), false);
  assert.equal(proxyAuthorized("Basic", credentials), false);
});

test("resolveProxy answers: the first supported entry wins, DIRECT otherwise", () => {
  assert.deepEqual(parseProxyList("PROXY 127.0.0.1:6152; SOCKS5 127.0.0.1:6153; DIRECT"), [
    { kind: "http", host: "127.0.0.1", port: 6152 },
    { kind: "socks5", host: "127.0.0.1", port: 6153 },
    { kind: "direct" },
  ]);
  assert.deepEqual(pickProxyRoute("DIRECT"), { kind: "direct" });
  assert.deepEqual(pickProxyRoute(""), { kind: "direct" });
  assert.deepEqual(pickProxyRoute("SOCKS proxy.lan:1080"), { kind: "socks5", host: "proxy.lan", port: 1080 });
  assert.deepEqual(pickProxyRoute("HTTPS secure.proxy:443; DIRECT"), { kind: "https", host: "secure.proxy", port: 443 });
  assert.deepEqual(pickProxyRoute("QUIC x:1; PROXY [::1]:8080"), { kind: "http", host: "::1", port: 8080 });
  assert.equal(connectProbeUrl({ host: "example.com", port: 443 }), "https://example.com:443/");
});

test("SOCKS5 and upstream CONNECT bytes", () => {
  assert.deepEqual([...socks5ConnectRequest("example.com", 443)], [5, 1, 0, 3, 11, ...Buffer.from("example.com"), 1, 187]);
  assert.deepEqual([...socks5ConnectRequest("10.0.0.2", 80)], [5, 1, 0, 1, 10, 0, 0, 2, 0, 80]);
  const v6 = socks5ConnectRequest("[2001:db8::1]", 8080);
  assert.equal(v6[3], 4);
  assert.deepEqual([...v6.subarray(4, 20)], [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(socks5ReplyLength(Buffer.from([5, 0, 0, 1, 0, 0])), 0);
  assert.equal(socks5ReplyLength(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x1f, 0x90, 99])), 10);
  assert.equal(socks5ReplyLength(Buffer.from([5, 0, 0, 3, 3, 97, 98, 99, 0, 80])), 10);
  assert.throws(() => socks5ReplyLength(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
  assert.equal(upstreamConnectRequest({ host: "example.com", port: 443 }).toString(), "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  assert.equal(connectResponseStatus(Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")), 200);
  assert.equal(connectResponseStatus(Buffer.from("HTTP/1.0 407 Proxy Auth\r\n\r\n")), 407);
  assert.equal(connectResponseStatus(Buffer.from("nonsense")), null);
});
