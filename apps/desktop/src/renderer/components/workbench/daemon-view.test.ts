import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopDaemonState } from "@/desktop-bridge";
import {
  authorizeStepDetail,
  resolveDaemonActions,
  resolveOnboardingPage,
  resolveOnboardingSteps,
  shouldOfferOnboarding,
} from "./daemon-view";

const RUNNING: DesktopDaemonState = {
  status: "running",
  bundled: true,
  bundledVersion: "v0.0.0-desktop.0.1.7",
  runningVersion: "v0.0.0-desktop.0.1.7",
  installed: true,
  running: true,
  registered: true,
  fda: "granted",
  daemonId: "d-1",
  binDir: "/Users/alice/.coflux/bin",
};
const NOT_INSTALLED: DesktopDaemonState = { status: "not-installed", bundled: true, installed: false, running: false, registered: false, fda: "unknown", binDir: "/Users/alice/.coflux/bin" };
const PENDING: DesktopDaemonState = { ...RUNNING, status: "pending-auth", registered: false, daemonId: undefined, authToken: "tok", fda: "unknown" };

test("移除接入永远要二次确认，且是破坏性动作", () => {
  const remove = resolveDaemonActions(RUNNING, 0).find((action) => action.id === "remove");
  assert.ok(remove?.confirm, "移除接入永远二次确认");
  assert.equal(remove?.kind, "destructive");
});

test("自动弹引导：只在中心已连上的 authed + 未接入 + 带 daemon + 没点过暂不 + 本次登录未弹过", () => {
  const base = { authState: "authed" as const, connection: "connected" as const, state: NOT_INSTALLED, dismissed: false, alreadyOffered: false };
  assert.equal(shouldOfferOnboarding(base), true);
  assert.equal(shouldOfferOnboarding({ ...base, connection: "connecting" }), false, "离线冷启动的 authed 来自缓存，不弹");
  assert.equal(shouldOfferOnboarding({ ...base, connection: "disconnected" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, authState: "authenticating" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, authState: "need-login" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, state: null }), false, "状态未到不弹");
  assert.equal(shouldOfferOnboarding({ ...base, state: RUNNING }), false, "已接入静默");
  assert.equal(shouldOfferOnboarding({ ...base, state: { ...RUNNING, status: "stopped", running: false } }), false);
  assert.equal(shouldOfferOnboarding({ ...base, state: { ...NOT_INSTALLED, bundled: false } }), false);
  assert.equal(shouldOfferOnboarding({ ...base, dismissed: true }), false);
  assert.equal(shouldOfferOnboarding({ ...base, alreadyOffered: true }), false);
});

test("引导页：未开始且未接入 = 说明页；进行中 = 进度页；已登记 = FDA 页或完成页", () => {
  const fresh = { started: false, authError: null, fdaSettled: false };
  assert.equal(resolveOnboardingPage(NOT_INSTALLED, fresh), "intro");
  assert.equal(resolveOnboardingPage(NOT_INSTALLED, { ...fresh, started: true }), "progress");
  assert.equal(resolveOnboardingPage({ ...NOT_INSTALLED, busy: "install" }, { ...fresh, started: true }), "progress");
  assert.equal(resolveOnboardingPage(PENDING, fresh), "progress", "从账号菜单进来时等待授权直接是进度页");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "unknown" }, fresh), "fda");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "denied" }, fresh), "fda");
  assert.equal(resolveOnboardingPage(RUNNING, fresh), "done", "已授予 FDA 直接完成");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "denied" }, { ...fresh, fdaSettled: true }), "done");
  // FDA 页点「重启服务」后进程短暂不在：不打回进度页
  assert.equal(resolveOnboardingPage({ ...RUNNING, status: "stopped", running: false, fda: "denied" }, { ...fresh, fdaSettled: true }), "done");
  assert.equal(resolveOnboardingPage({ ...RUNNING, status: "stopped", running: false, fda: "denied" }, fresh), "fda");
});

test("引导三步：安装 → 启动 → 授权 依次推进；失败落到对应步并给出重试动作", () => {
  const local = { started: true, authError: null, fdaSettled: false };
  const installing = resolveOnboardingSteps({ ...NOT_INSTALLED, busy: "install" }, local);
  assert.deepEqual([installing.install, installing.start, installing.authorize], ["active", "pending", "pending"]);
  assert.equal(installing.failure, null);

  const starting = resolveOnboardingSteps({ ...NOT_INSTALLED, installed: true, busy: "start" }, local);
  assert.deepEqual([starting.install, starting.start, starting.authorize], ["done", "active", "pending"]);
  // launchctl load 返回后、pid 还没出现：启动步仍是进行中
  const waitingPid = resolveOnboardingSteps({ ...RUNNING, status: "stopped", running: false, registered: false }, local);
  assert.deepEqual([waitingPid.install, waitingPid.start, waitingPid.authorize], ["done", "active", "pending"]);

  const authorizing = resolveOnboardingSteps(PENDING, local);
  assert.deepEqual([authorizing.install, authorizing.start, authorizing.authorize], ["done", "done", "active"]);
  assert.equal(authorizeStepDetail(PENDING, local), "授权中…（用当前登录账号）");
  assert.match(authorizeStepDetail({ ...PENDING, authToken: undefined }, local), /正在连接账号服务器/);

  const done = resolveOnboardingSteps(RUNNING, local);
  assert.deepEqual([done.install, done.start, done.authorize], ["done", "done", "done"]);
  assert.equal(authorizeStepDetail(RUNNING, local), "已用当前登录账号完成");

  const installFailed = resolveOnboardingSteps({ ...NOT_INSTALLED, error: { action: "install", message: "codesign 重签失败" } }, local);
  assert.equal(installFailed.install, "failed");
  assert.equal(installFailed.start, "pending");
  assert.equal(installFailed.failure, "安装组件失败：codesign 重签失败");
  assert.equal(installFailed.retry, "enroll");

  const startFailed = resolveOnboardingSteps({ ...NOT_INSTALLED, installed: true, error: { action: "start", message: "launchctl load 失败" } }, local);
  assert.deepEqual([startFailed.install, startFailed.start], ["done", "failed"]);
  assert.equal(startFailed.retry, "enroll");

  const authFailed = resolveOnboardingSteps(PENDING, { ...local, authError: "token 已过期" });
  assert.equal(authFailed.authorize, "failed");
  assert.equal(authFailed.failure, "授权失败：token 已过期");
  assert.equal(authFailed.retry, "authorize");
  assert.equal(authorizeStepDetail(PENDING, { ...local, authError: "token 已过期" }), "token 已过期");
  // 未开始（说明页）时三步全 pending
  const idle = resolveOnboardingSteps(NOT_INSTALLED, { ...local, started: false });
  assert.deepEqual([idle.install, idle.start, idle.authorize], ["pending", "pending", "pending"]);
});
