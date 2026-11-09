import assert from "node:assert/strict";
import { test } from "node:test";

import { findUrlRanges } from "./terminal-web-links";

const urls = (text: string) => findUrlRanges(text).map((range) => range.text);

test("CJK punctuation after a URL ends it, CJK letters do not", () => {
  assert.deepEqual(urls("打开 https://cchost.ai/docs，然后登录"), ["https://cchost.ai/docs"]);
  assert.deepEqual(urls("见 https://github.com/a/b/pull/12。"), ["https://github.com/a/b/pull/12"]);
  assert.deepEqual(urls("链接：https://example.com/x这是中文说明"), ["https://example.com/x这是中文说明"]);
  assert.deepEqual(urls("https://zh.wikipedia.org/wiki/中文 后面"), ["https://zh.wikipedia.org/wiki/中文"]);
  assert.deepEqual(urls("https://example.com/a…"), ["https://example.com/a"]);
  assert.deepEqual(urls("https://a.com、https://b.com"), ["https://a.com", "https://b.com"]);
});

test("CJK brackets around a URL are not part of it", () => {
  assert.deepEqual(urls("（https://example.com/path）"), ["https://example.com/path"]);
  assert.deepEqual(urls("「https://example.com」"), ["https://example.com"]);
  assert.deepEqual(urls("【https://example.com/x】"), ["https://example.com/x"]);
  assert.deepEqual(urls("https://example.com/a)】 下一句"), ["https://example.com/a"]);
});

test("an ASCII closing bracket belongs to the URL only if it closes one opened inside it", () => {
  assert.deepEqual(urls("(see https://en.wikipedia.org/wiki/Foo_(bar))"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  assert.deepEqual(urls("[docs](https://example.com/p)"), ["https://example.com/p"]);
  assert.deepEqual(urls("https://a.com/x?y=[2]&z={3}"), ["https://a.com/x?y=[2]&z={3}"]);
});

test("trailing sentence punctuation and quotes are not part of the URL", () => {
  assert.deepEqual(urls("Visit https://example.com."), ["https://example.com"]);
  assert.deepEqual(urls("https://example.com/?q=1;"), ["https://example.com/?q=1"]);
  assert.deepEqual(urls("https://example.com/a!"), ["https://example.com/a"]);
  assert.deepEqual(urls('"https://example.com"'), ["https://example.com"]);
  assert.deepEqual(urls("http://localhost:3000/"), ["http://localhost:3000/"]);
});

test("a bare scheme or a host without a scheme is not a link", () => {
  assert.deepEqual(urls("https://"), []);
  assert.deepEqual(urls("see example.com"), []);
});
