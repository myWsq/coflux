import assert from "node:assert/strict";
import { test } from "node:test";

import { executorCancelReason, type ExecutorStopTrigger } from "./executor-lifecycle";
import type { StopReason } from "./daemon-manager";

const confirmed = (reason: StopReason): ExecutorStopTrigger => ({ kind: "runtime-stop", reason, confirmed: true });
const declined = (reason: StopReason): ExecutorStopTrigger => ({ kind: "runtime-stop", reason, confirmed: false });

test("用户确认的退出 / 退出登录 / 停止都取消在跑的任务，并说明是哪个动作", () => {
  // 面板的「停止」与「移除」都走 stopConfirmed("stop")：两者都会结束 executor 工具进程所在的运行时。
  for (const reason of ["quit", "logout", "stop"] as const) {
    const text = executorCancelReason(confirmed(reason));
    assert.equal(typeof text, "string", reason);
    assert.notEqual(text, "", reason);
    assert.ok(text?.includes("任务被中断"), `${reason}: ${text}`);
  }
  // 三条的措辞互不相同：CLI 那头原样打给用户，说不清是哪个动作等于没说
  const texts = new Set((["quit", "logout", "stop"] as const).map((r) => executorCancelReason(confirmed(r))));
  assert.equal(texts.size, 3);
});

test("app 真的在退出时取消，且与运行时停止是两条独立入口", () => {
  // 退出安装更新自己置 quitting、不经 stopConfirmed，只有这条能盖住它
  const text = executorCancelReason({ kind: "app-exit" });
  assert.ok(text?.includes("任务被中断"), String(text));
});

test("取消退出对话框、重启、迁移、通道断开都不动在跑的任务", () => {
  // 用户在确认框上点了取消：什么都没停，也就不能取消任何任务
  for (const reason of ["quit", "logout", "stop", "restart", "migrate"] as const) {
    assert.equal(executorCancelReason(declined(reason)), null, reason);
  }
  // 重启后同一个运行时马上回来，app 自始至终没走；对用户只是一次闪断
  assert.equal(executorCancelReason(confirmed("restart")), null);
  // 迁移停的是旧 LaunchAgent，不是本 app，那边不托管任何 executor 任务
  assert.equal(executorCancelReason(confirmed("migrate")), null);
  // 通道断了不等于 app 死了：任务还在跑，重连后靠对账补状态；断线就当没跑会造成双写
  assert.equal(executorCancelReason({ kind: "device-channel-lost" }), null);
});
