import assert from "node:assert/strict";
import { test } from "node:test";

import { bundledSupervisorIsNewer, compareReleaseVersions, parseReleaseVersion } from "./daemon-version";

test("解析：v 前缀严格 SemVer，含 prerelease / build metadata；dev、无前缀、前导零一律 null", () => {
  assert.deepEqual(parseReleaseVersion("v0.32.0"), { major: 0, minor: 32, patch: 0, prerelease: [] });
  assert.deepEqual(parseReleaseVersion("v0.0.0-desktop.0.1.7"), { major: 0, minor: 0, patch: 0, prerelease: ["desktop", "0", "1", "7"] });
  // 桌面 tag 自带 prerelease 时拼出来的标识符含连字符，仍是合法 SemVer
  assert.deepEqual(parseReleaseVersion("v0.0.0-desktop.0.1.7-rc.1")?.prerelease, ["desktop", "0", "1", "7-rc", "1"]);
  assert.deepEqual(parseReleaseVersion("v1.2.3+build.5")?.prerelease, []);
  // supervisor-version 文件带换行：原文 + \n
  assert.deepEqual(parseReleaseVersion("v0.32.0\n"), { major: 0, minor: 32, patch: 0, prerelease: [] });
  for (const bad of ["dev", "", "0.32.0", "v01.2.3", "v1.2", "v1.2.3-01", "unknown", null, undefined]) {
    assert.equal(parseReleaseVersion(bad), null, String(bad));
  }
});

test("比较：主次修订数值序；prerelease 低于正式；标识符数字 < 字母、同前缀更长者更新", () => {
  const v = (raw: string) => parseReleaseVersion(raw)!;
  assert.ok(compareReleaseVersions(v("v0.33.0"), v("v0.32.9")) > 0);
  assert.ok(compareReleaseVersions(v("v0.32.0"), v("v0.32.0-rc.1")) > 0);
  assert.ok(compareReleaseVersions(v("v0.32.0-rc.1"), v("v0.32.0-rc.2")) < 0);
  assert.ok(compareReleaseVersions(v("v0.32.0-alpha"), v("v0.32.0-alpha.1")) < 0);
  assert.ok(compareReleaseVersions(v("v0.32.0-1"), v("v0.32.0-alpha")) < 0);
  assert.equal(compareReleaseVersions(v("v1.0.0+a"), v("v1.0.0+b")), 0);
  // 内置版本戳低于一切正式版：npm 装过正式 supervisor 的机器不会被提示换成内置版（决策后果）
  assert.ok(compareReleaseVersions(v("v0.0.0-desktop.0.1.7"), v("v0.32.0")) < 0);
  assert.ok(compareReleaseVersions(v("v0.0.0-desktop.0.1.8"), v("v0.0.0-desktop.0.1.7")) > 0);
  assert.ok(compareReleaseVersions(v("v0.0.0-desktop.0.2.0"), v("v0.0.0-desktop.0.1.10")) > 0);
});

test("有更新待重启：内置严格更新才提示；在跑的 dev / 缺失视为旧；内置解析不了永不提示", () => {
  assert.equal(bundledSupervisorIsNewer("v0.0.0-desktop.0.1.8", "v0.0.0-desktop.0.1.7\n"), true);
  assert.equal(bundledSupervisorIsNewer("v0.0.0-desktop.0.1.7", "v0.0.0-desktop.0.1.7"), false);
  assert.equal(bundledSupervisorIsNewer("v0.0.0-desktop.0.1.7", "v0.32.0"), false, "npm 正式版更新，不提示");
  assert.equal(bundledSupervisorIsNewer("v0.0.0-desktop.0.1.7", "dev"), true, "在跑的是本地 dev 构建");
  assert.equal(bundledSupervisorIsNewer("v0.0.0-desktop.0.1.7", null), true, "112 之前的老 supervisor 没写版本文件");
  assert.equal(bundledSupervisorIsNewer("dev", "v0.32.0"), false, "本机 pack 的内置版本戳解析不了");
  assert.equal(bundledSupervisorIsNewer("dev", null), false);
  assert.equal(bundledSupervisorIsNewer(null, null), false, "本构建不带 daemon");
});
