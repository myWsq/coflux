import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { checkProductVersion, setProductVersion, VERSION_FILES } from "./product-version.mjs";
import { renderDesktopFeed } from "./desktop-update-feed.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coflux-product-version-"));
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify({ version: "0.34.0", name: file, keep: true }));
  }
  return root;
}
test("统一版本修改同时更新桌面和 CLI，保留其余字段", () => {
  const root = fixture();
  try {
    assert.equal(setProductVersion(root, "0.35.0"), "0.35.0");
    assert.equal(checkProductVersion(root, "v0.35.0"), "0.35.0");
    for (const file of VERSION_FILES) assert.equal(JSON.parse(readFileSync(join(root, file))).keep, true);
    assert.throws(() => checkProductVersion(root, "desktop-v0.35.0"), /tag/);
    assert.throws(() => checkProductVersion(root, "v0.34.0"), /tag/);
    writeFileSync(join(root, VERSION_FILES[1]), '{"version":"0.34.0"}');
    assert.throws(() => checkProductVersion(root), /不一致/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("非法版本和降级在任何 manifest 被改动前被拒绝", () => {
  const root = fixture();
  try {
    const before = VERSION_FILES.map(file => readFileSync(join(root, file), "utf8"));
    for (const version of ["0.33.0", "0.35.0-01", "0.35.0+other", "v0.35.0", "0.035.0"]) assert.throws(() => setProductVersion(root, version));
    assert.deepEqual(VERSION_FILES.map(file => readFileSync(join(root, file), "utf8")), before);
    assert.equal(setProductVersion(root, "0.35.0-beta.1"), "0.35.0-beta.1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const manifest = version => `version: ${version}\nfiles:\n  - url: coflux-${version}-arm64.zip\n    sha512: test-digest\npath: coflux-${version}-arm64.zip\nsha512: test-digest\n`;
test("桌面更新源指向统一 tag，保留摘要并允许同内容重试", () => {
  const rendered = renderDesktopFeed("v0.34.0", "owner/coflux", manifest("0.34.0"));
  assert.match(rendered, /releases\/download\/v0.34.0\/coflux-0.34.0-arm64.zip/);
  assert.match(rendered, /sha512: test-digest/);
  assert.equal(renderDesktopFeed("v0.34.0", "owner/coflux", manifest("0.34.0"), rendered), rendered);
});
test("更新源拒绝版本错配、旧 run、同版本漂移和预发布污染", () => {
  const newer = renderDesktopFeed("v0.35.0", "owner/coflux", manifest("0.35.0"));
  assert.throws(() => renderDesktopFeed("v0.34.0", "owner/coflux", manifest("0.34.0"), newer), /旧发布/);
  assert.throws(() => renderDesktopFeed("v0.35.0", "owner/coflux", manifest("0.35.0").replaceAll("test-digest", "changed"), newer), /漂移/);
  assert.throws(() => renderDesktopFeed("v0.34.0", "owner/coflux", manifest("0.35.0")), /不一致/);
  assert.throws(() => renderDesktopFeed("v0.35.0-beta.1", "owner/coflux", manifest("0.35.0-beta.1")), /预发布/);
  assert.throws(() => renderDesktopFeed("v0.34.0", "owner/coflux", manifest("0.34.0").replace("url: coflux", "url: https://other/coflux")), /地址/);
});
