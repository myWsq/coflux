import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { locateClaudePluginDir, locateDaemonBundle, resolveDaemonBundleDir } from "./daemon-bundle";
import { DAEMON_BINARIES } from "./daemon-paths";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "coflux-daemon-bundle-"));
  try {
    run(dir);
  } finally {
    // 只删 mkdtemp 返回的路径
    if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  }
}

test("定位目录：打包版 <resourcesPath>/daemon，dev 实例 <appPath>/build/daemon（与 stage 脚本同源）", () => {
  assert.equal(resolveDaemonBundleDir({ packaged: true, resourcesPath: "/Applications/Coflux.app/Contents/Resources", appPath: "/x" }), "/Applications/Coflux.app/Contents/Resources/daemon");
  assert.equal(resolveDaemonBundleDir({ packaged: false, resourcesPath: "/x", appPath: "/repo/apps/desktop" }), "/repo/apps/desktop/build/daemon");
});

test("三件齐全才算带 daemon；VERSION 原文 trim 透出，缺失为 null", () => {
  withTempDir((dir) => {
    for (const name of DAEMON_BINARIES) writeFileSync(join(dir, name), "#!/bin/sh\n");
    assert.deepEqual(locateDaemonBundle(dir), { dir, version: null });
    writeFileSync(join(dir, "VERSION"), "v0.0.0-desktop.0.1.7\n");
    assert.deepEqual(locateDaemonBundle(dir), { dir, version: "v0.0.0-desktop.0.1.7" });
    writeFileSync(join(dir, "VERSION"), "\n");
    assert.equal(locateDaemonBundle(dir)?.version, null);
  });
});

test("内置插件目录：资源目录下的 claude-plugin/ 带清单才算数，与三件无关（plan 115）", () => {
  withTempDir((dir) => {
    assert.equal(locateClaudePluginDir(dir), null); // 没跑过 stage 脚本的 dev 实例
    const plugin = join(dir, "claude-plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    assert.equal(locateClaudePluginDir(dir), null, "空目录不算带插件");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), `{"name":"coflux"}\n`);
    assert.equal(locateClaudePluginDir(dir), plugin);
    // 三件一个都没有也照样透出插件目录：插件是普通文件，与 daemon 二进制的存在性无关
    assert.equal(locateDaemonBundle(dir), null);
    assert.equal(locateClaudePluginDir(join(dir, "missing")), null);
  });
});

test("缺任一件、空文件、目录不存在 → null（本构建不带 daemon，不崩）", () => {
  withTempDir((dir) => {
    assert.equal(locateDaemonBundle(join(dir, "missing")), null);
    for (const name of DAEMON_BINARIES) writeFileSync(join(dir, name), "x");
    writeFileSync(join(dir, "coflux"), "");
    assert.equal(locateDaemonBundle(dir), null, "空文件不算");
    rmSync(join(dir, "coflux"));
    mkdirSync(join(dir, "coflux"));
    assert.equal(locateDaemonBundle(dir), null, "同名目录不算");
  });
});
