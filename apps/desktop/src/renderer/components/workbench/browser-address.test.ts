import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEARCH_URL_PREFIX,
  displayUrl,
  hostLabel,
  isBrowsableUrl,
  isLoopbackUrl,
  localPortUrl,
  loopbackPortOf,
  normalizeIncomingUrl,
  resolveAddressInput,
  rewriteUnspecifiedHost,
} from "./browser-address";

function urlOf(input: string): string | undefined {
  const result = resolveAddressInput(input);
  return result?.kind === "url" ? result.url : undefined;
}

function isSearch(input: string): boolean {
  return resolveAddressInput(input)?.kind === "search";
}

test("a bare port is this workspace's localhost on that port", () => {
  assert.equal(urlOf("5173"), "http://localhost:5173/");
  assert.equal(urlOf(" 3000 "), "http://localhost:3000/");
  assert.equal(localPortUrl(8080), "http://localhost:8080/");
  // Not a port: searched.
  assert.equal(isSearch("0"), true);
  assert.equal(isSearch("70000"), true);
});

test("host:port and hostnames get http://, with or without a path", () => {
  assert.equal(urlOf("localhost:3000"), "http://localhost:3000/");
  assert.equal(urlOf("localhost"), "http://localhost/");
  assert.equal(urlOf("localhost:5173/docs?x=1"), "http://localhost:5173/docs?x=1");
  assert.equal(urlOf("example.com"), "http://example.com/");
  assert.equal(urlOf("sub.example.co.uk/path"), "http://sub.example.co.uk/path");
  assert.equal(urlOf("192.168.1.20:8000"), "http://192.168.1.20:8000/");
  assert.equal(urlOf("[::1]:5173"), "http://[::1]:5173/");
  assert.equal(urlOf("app.localhost:3000"), "http://app.localhost:3000/");
  assert.equal(urlOf("devbox:8080"), "http://devbox:8080/");
});

test("a full http(s) URL is taken as it is; about:blank too", () => {
  assert.equal(urlOf("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d");
  assert.equal(urlOf("HTTP://Example.com"), "http://example.com/");
  assert.equal(urlOf("about:blank"), "about:blank");
});

test("anything that is not URL-like is a web search", () => {
  const result = resolveAddressInput("how to center a div");
  assert.deepEqual(result, { kind: "search", url: `${SEARCH_URL_PREFIX}how%20to%20center%20a%20div`, query: "how to center a div" });
  assert.equal(isSearch("react"), true);
  assert.equal(isSearch("1.2"), true);
  assert.equal(isSearch("file:///etc/passwd"), true);
  assert.equal(isSearch("javascript:alert(1)"), true);
  assert.equal(isSearch("ftp://example.com"), true);
  assert.equal(isSearch("user@example.com"), true);
  assert.equal(isSearch("中文 搜索"), true);
  assert.equal(resolveAddressInput("   "), null);
});

test("0.0.0.0 and [::] are rewritten to localhost wherever a URL enters", () => {
  assert.equal(urlOf("0.0.0.0:8080"), "http://localhost:8080/");
  assert.equal(urlOf("http://0.0.0.0:3000/app"), "http://localhost:3000/app");
  assert.equal(rewriteUnspecifiedHost("http://[::]:4000/"), "http://localhost:4000/");
  assert.equal(rewriteUnspecifiedHost("https://example.com/"), "https://example.com/");
  assert.equal(normalizeIncomingUrl("http://0.0.0.0:5173/"), "http://localhost:5173/");
  assert.equal(normalizeIncomingUrl("file:///tmp/x"), null);
  assert.equal(normalizeIncomingUrl("about:blank"), null);
});

test("loopback detection covers localhost, 127/8, [::1], 0.0.0.0 and *.localhost", () => {
  assert.equal(isLoopbackUrl(urlOf("5173")!), true);
  assert.equal(isLoopbackUrl("http://127.0.0.1:3000/"), true);
  assert.equal(isLoopbackUrl("http://127.4.5.6/"), true);
  assert.equal(isLoopbackUrl("http://[::1]:5173/"), true);
  assert.equal(isLoopbackUrl("http://0.0.0.0/"), true);
  assert.equal(isLoopbackUrl("http://my-app.localhost:3000/"), true);
  assert.equal(isLoopbackUrl(urlOf("example.com")!), false);
  assert.equal(loopbackPortOf("http://localhost:5173/"), 5173);
  assert.equal(loopbackPortOf("http://localhost/"), 80);
  assert.equal(loopbackPortOf("https://example.com:8443/"), null);
});

test("only http(s) and about:blank are browsable; display helpers", () => {
  assert.equal(isBrowsableUrl("http://a.com/"), true);
  assert.equal(isBrowsableUrl("about:blank"), true);
  assert.equal(isBrowsableUrl("file:///x"), false);
  assert.equal(isBrowsableUrl("devtools://devtools/bundled/x.html"), false);
  assert.equal(displayUrl("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(displayUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(displayUrl("about:blank"), "");
  assert.equal(hostLabel("http://localhost:5173/x"), "localhost:5173");
});
