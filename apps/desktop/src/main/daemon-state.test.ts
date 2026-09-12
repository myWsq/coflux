import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveDaemonState, type DaemonFacts } from "./daemon-state";

const BASE: DaemonFacts = {
  bundle: { version: "v0.0.0-desktop.0.1.7" },
  installationExists: true,
  supervisorExists: true,
  workerExists: true,
  registered: true,
  daemonId: "d-1",
  pendingAuth: null,
  running: true,
  fda: "granted",
  runningVersion: "v0.0.0-desktop.0.1.7",
  binDir: "/Users/alice/.coflux/bin",
};

test("已接入 = plist 与两个二进制都在，缺任一即未接入（不分 npm / app 来源）", () => {
  assert.equal(deriveDaemonState(BASE).status, "running");
  assert.equal(deriveDaemonState({ ...BASE, installationExists: false }).status, "not-installed");
  assert.equal(deriveDaemonState({ ...BASE, supervisorExists: false }).status, "not-installed");
  assert.equal(deriveDaemonState({ ...BASE, workerExists: false }).status, "not-installed");
  assert.equal(deriveDaemonState({ ...BASE, workerExists: false }).installed, false);
  // 未接入但进程还在（残留）也只报未接入；已接入不在跑 = 已停止
  assert.equal(deriveDaemonState({ ...BASE, running: false }).status, "stopped");
});

test("在跑未登记 = 等待授权：token 与过期时刻透出；已登记后即使文件残留也不透出", () => {
  const pending = deriveDaemonState({ ...BASE, registered: false, daemonId: null, pendingAuth: { token: "tok", expiresAt: 42 } });
  assert.equal(pending.status, "pending-auth");
  assert.equal(pending.authToken, "tok");
  assert.equal(pending.authExpiresAt, 42);
  assert.equal(pending.daemonId, undefined);
  // 链接还没落盘：仍是等待授权，只是没有 token（渲染层显示正在获取链接）
  const noLink = deriveDaemonState({ ...BASE, registered: false, daemonId: null, pendingAuth: null });
  assert.equal(noLink.status, "pending-auth");
  assert.equal(noLink.authToken, undefined);
  const stale = deriveDaemonState({ ...BASE, pendingAuth: { token: "old" } });
  assert.equal(stale.status, "running");
  assert.equal(stale.authToken, undefined);
  // 已停止时未登记也只报已停止（先起服务才谈授权）
  assert.equal(deriveDaemonState({ ...BASE, running: false, registered: false }).status, "stopped");
});

test("有更新待重启：内置更新且在跑已登记；在跑 dev / 缺版本文件也算；内置 dev 或不带 daemon 永不", () => {
  assert.equal(deriveDaemonState({ ...BASE, bundle: { version: "v0.0.0-desktop.0.1.8" } }).status, "update-ready");
  assert.equal(deriveDaemonState({ ...BASE, runningVersion: "dev" }).status, "update-ready");
  assert.equal(deriveDaemonState({ ...BASE, runningVersion: null }).status, "update-ready");
  assert.equal(deriveDaemonState({ ...BASE, runningVersion: "v0.32.0" }).status, "running", "npm 正式版更新，不提示");
  assert.equal(deriveDaemonState({ ...BASE, bundle: { version: "dev" } }).status, "running");
  assert.equal(deriveDaemonState({ ...BASE, bundle: { version: null } }).status, "running");
  const unbundled = deriveDaemonState({ ...BASE, bundle: null, runningVersion: null });
  assert.equal(unbundled.status, "running");
  assert.equal(unbundled.bundled, false);
  assert.equal(unbundled.bundledVersion, undefined);
  // 更新只在「在跑已登记」时提示；等待授权 / 已停止各归其位
  assert.equal(deriveDaemonState({ ...BASE, runningVersion: null, registered: false }).status, "pending-auth");
  assert.equal(deriveDaemonState({ ...BASE, runningVersion: null, running: false }).status, "stopped");
});

test("透传字段：版本原文、fda、binDir、daemonId、busy、error；空值不出现在对象上", () => {
  const state = deriveDaemonState({ ...BASE, fda: "denied", busy: "restart", error: { action: "start", message: "launchctl load 失败" } });
  assert.equal(state.bundled, true);
  assert.equal(state.bundledVersion, "v0.0.0-desktop.0.1.7");
  assert.equal(state.runningVersion, "v0.0.0-desktop.0.1.7");
  assert.equal(state.fda, "denied");
  assert.equal(state.binDir, "/Users/alice/.coflux/bin");
  assert.equal(state.daemonId, "d-1");
  assert.equal(state.busy, "restart");
  assert.deepEqual(state.error, { action: "start", message: "launchctl load 失败" });

  const bare = deriveDaemonState({ ...BASE, runningVersion: null, daemonId: null, bundle: null });
  assert.ok(!("bundledVersion" in bare));
  assert.ok(!("runningVersion" in bare));
  assert.ok(!("daemonId" in bare));
  assert.ok(!("busy" in bare));
  assert.ok(!("error" in bare));
  assert.ok(!("authToken" in bare));
});
