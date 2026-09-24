import assert from "node:assert/strict";
import { test } from "node:test";

import { isLoopbackHost, isLoopbackUrl } from "./browser-loopback";

test("localhost and every *.localhost name are loopback", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("localhost."), true);
  assert.equal(isLoopbackHost("app.localhost"), true);
  assert.equal(isLoopbackHost("a.b.localhost"), true);
  assert.equal(isLoopbackHost("localhost.example.com"), false);
  assert.equal(isLoopbackHost("notlocalhost"), false);
});

test("all of 127.0.0.0/8 and 0.0.0.0 are loopback; other IPv4 is not", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.1.2.3"), true);
  assert.equal(isLoopbackHost("127.255.255.255"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), true);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("10.0.0.1"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("127.0.0.256"), false);
});

test("[::1], [::] and IPv4-mapped loopback are loopback; other IPv6 is not", () => {
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[0:0:0:0:0:0:0:1]"), true);
  assert.equal(isLoopbackHost("[::]"), true);
  assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), true);
  assert.equal(isLoopbackHost("[::ffff:7f00:1]"), true);
  assert.equal(isLoopbackHost("[::ffff:0a00:1]"), false);
  assert.equal(isLoopbackHost("[2001:db8::1]"), false);
  assert.equal(isLoopbackHost("[fe80::1]"), false);
  assert.equal(isLoopbackHost("[::2]"), false);
});

test("public names and junk are not loopback", () => {
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost("[]"), false);
  assert.equal(isLoopbackHost("[:::1]"), false);
});

test("URLs are classified by their normalised host, whatever the scheme", () => {
  assert.equal(isLoopbackUrl("http://localhost:5173/"), true);
  assert.equal(isLoopbackUrl("https://127.0.0.1:8443/app"), true);
  assert.equal(isLoopbackUrl("http://127.1:3000/"), true);
  assert.equal(isLoopbackUrl("ws://[::1]:24678/"), true);
  assert.equal(isLoopbackUrl("http://0.0.0.0:8080/"), true);
  assert.equal(isLoopbackUrl("http://dev.localhost:3000/"), true);
  assert.equal(isLoopbackUrl("https://example.com/localhost"), false);
  assert.equal(isLoopbackUrl("http://localhost.example.com/"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});
