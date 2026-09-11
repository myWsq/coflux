import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus, type Task } from "@coflux/protocol";

import type { DesktopDaemonState } from "@/desktop-bridge";
import {
  authorizeStepDetail,
  countLocalRunningTerminals,
  daemonStatusLine,
  resolveDaemonActions,
  resolveOnboardingPage,
  resolveOnboardingSteps,
  shouldOfferOnboarding,
  terminalsImpact,
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

test("状态行：五种状态各有短语；FDA 未授予与失败原因进副文案；进行中动作覆盖一切", () => {
  assert.deepEqual(daemonStatusLine(RUNNING), { label: "运行中", detail: "", tone: "success", pulsing: false });
  assert.deepEqual(daemonStatusLine({ ...RUNNING, fda: "denied" }), { label: "运行中", detail: "未授予完全磁盘访问", tone: "warning", pulsing: false });
  assert.equal(daemonStatusLine({ ...RUNNING, status: "stopped", running: false }).label, "已停止");
  assert.equal(daemonStatusLine({ ...RUNNING, status: "stopped", running: false }).tone, "warning");
  const pending = daemonStatusLine(PENDING);
  assert.equal(pending.label, "等待授权");
  assert.equal(pending.pulsing, true);
  assert.match(daemonStatusLine({ ...PENDING, authToken: undefined }).detail, /授权链接/);
  const update = daemonStatusLine({ ...RUNNING, status: "update-ready", bundledVersion: "v0.0.0-desktop.0.1.8" });
  assert.equal(update.label, "有更新待重启");
  assert.match(update.detail, /0\.1\.8/);
  assert.match(update.detail, /0\.1\.7/);
  assert.match(daemonStatusLine({ ...RUNNING, status: "update-ready", runningVersion: undefined }).detail, /未知版本/);
  assert.equal(daemonStatusLine(NOT_INSTALLED).label, "未接入");
  assert.match(daemonStatusLine({ ...NOT_INSTALLED, bundled: false }).detail, /npm i -g cofluxd/);
  // 失败：原因进副文案、红色
  const failed = daemonStatusLine({ ...NOT_INSTALLED, error: { action: "start", message: "launchctl load 失败" } });
  assert.equal(failed.tone, "error");
  assert.equal(failed.detail, "启动服务失败：launchctl load 失败");
  // 进行中
  const busy = daemonStatusLine({ ...RUNNING, busy: "restart" });
  assert.deepEqual(busy, { label: "正在重启服务…", detail: "", tone: "accent", pulsing: true });
});

test("可见动作：按状态给；busy 无动作；有终端时重启/停止要确认；更新永远确认且带终端数；FDA 只在未授予时出现", () => {
  const ids = (state: DesktopDaemonState, n = 0) => resolveDaemonActions(state, n).map((action) => action.id);
  assert.deepEqual(ids(NOT_INSTALLED), ["enroll"]);
  assert.deepEqual(ids({ ...NOT_INSTALLED, bundled: false }), [], "本构建不带 daemon 不能接入");
  assert.deepEqual(ids({ ...RUNNING, status: "stopped", running: false }), ["start", "remove"]);
  assert.deepEqual(ids(PENDING), ["authorize", "restart", "stop", "remove"]);
  assert.deepEqual(ids(RUNNING), ["restart", "stop", "remove"]);
  assert.deepEqual(ids({ ...RUNNING, fda: "denied" }), ["fda", "restart", "stop", "remove"]);
  assert.deepEqual(ids({ ...RUNNING, status: "update-ready" }), ["update", "stop", "remove"]);
  assert.deepEqual(ids({ ...RUNNING, status: "update-ready", fda: "unknown" }), ["update", "fda", "stop", "remove"]);
  assert.deepEqual(ids({ ...RUNNING, busy: "stop" }), []);

  const quiet = resolveDaemonActions(RUNNING, 0);
  assert.equal(quiet.find((action) => action.id === "restart")?.confirm, undefined);
  assert.equal(quiet.find((action) => action.id === "stop")?.confirm, undefined);
  assert.ok(quiet.find((action) => action.id === "remove")?.confirm, "移除接入永远二次确认");
  assert.equal(quiet.find((action) => action.id === "remove")?.kind, "destructive");

  const loud = resolveDaemonActions(RUNNING, 3);
  assert.match(loud.find((action) => action.id === "restart")?.confirm?.description ?? "", /3 个/);
  assert.match(loud.find((action) => action.id === "stop")?.confirm?.description ?? "", /3 个/);

  const update = resolveDaemonActions({ ...RUNNING, status: "update-ready", bundledVersion: "v0.0.0-desktop.0.1.8" }, 2).find((action) => action.id === "update");
  assert.equal(update?.kind, "primary");
  assert.match(update?.confirm?.title ?? "", /0\.1\.8/);
  assert.match(update?.confirm?.description ?? "", /会结束本机 2 个/);
  assert.match(update?.confirm?.description ?? "", /从不自动重启/);
  const updateQuiet = resolveDaemonActions({ ...RUNNING, status: "update-ready" }, 0).find((action) => action.id === "update");
  assert.ok(updateQuiet?.confirm, "没有终端也要确认");
  assert.match(updateQuiet?.confirm?.description ?? "", /没有正在运行的终端/);

  assert.equal(terminalsImpact(0), "本机当前没有正在运行的终端。");
  assert.match(terminalsImpact(5), /^会结束本机 5 个/);
});

test("本机运行中终端数：按 daemonId 匹配、只数 RUNNING；没有 daemonId 为 0", () => {
  const task = (id: string, daemonId: string, status: TaskStatus) => ({ id, daemonId, status }) as unknown as Task;
  const tasks = [task("a", "d-1", TaskStatus.RUNNING), task("b", "d-1", TaskStatus.EXITED), task("c", "d-2", TaskStatus.RUNNING), task("d", "d-1", TaskStatus.RUNNING)];
  assert.equal(countLocalRunningTerminals(tasks, "d-1"), 2);
  assert.equal(countLocalRunningTerminals(tasks, "d-2"), 1);
  assert.equal(countLocalRunningTerminals(tasks, "d-9"), 0);
  assert.equal(countLocalRunningTerminals(tasks, undefined), 0);
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
  assert.match(authorizeStepDetail({ ...PENDING, authToken: undefined }, local), /等待 daemon/);

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
