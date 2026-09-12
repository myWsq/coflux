import assert from "node:assert/strict";
import { test } from "node:test";

import { executorCancelReason, type ExecutorStopTrigger } from "./executor-lifecycle";
import type { StopReason } from "./daemon-manager";

const confirmed = (reason: StopReason): ExecutorStopTrigger => ({ kind: "runtime-stop", reason, confirmed: true });
const declined = (reason: StopReason): ExecutorStopTrigger => ({ kind: "runtime-stop", reason, confirmed: false });

test("用户确认的退出 / 退出登录 / 停止都取消在跑的任务，并说明是哪个动作", () => {
  // The panel's "stop" and "remove" both go through stopConfirmed("stop"): either one ends the
  // runtime the executor's tool processes live on.
  for (const reason of ["quit", "logout", "stop"] as const) {
    const text = executorCancelReason(confirmed(reason));
    assert.equal(typeof text, "string", reason);
    assert.notEqual(text, "", reason);
    assert.ok(text?.includes("任务被中断"), `${reason}: ${text}`);
  }
  // The three read differently: the CLI prints them verbatim, and one that does not name the action
  // says nothing useful.
  const texts = new Set((["quit", "logout", "stop"] as const).map((r) => executorCancelReason(confirmed(r))));
  assert.equal(texts.size, 3);
});

test("app 真的在退出时取消，且与运行时停止是两条独立入口", () => {
  // Quit-and-install sets `quitting` itself and never goes through stopConfirmed; only this trigger
  // covers it.
  const text = executorCancelReason({ kind: "app-exit" });
  assert.ok(text?.includes("任务被中断"), String(text));
});

test("取消退出对话框、重启、迁移、通道断开都不动在跑的任务", () => {
  // The user dismissed the confirmation dialog: nothing was stopped, so nothing may be cancelled.
  for (const reason of ["quit", "logout", "stop", "restart", "migrate"] as const) {
    assert.equal(executorCancelReason(declined(reason)), null, reason);
  }
  // A restart brings the same runtime straight back and the app never left; to the user it is a blip.
  assert.equal(executorCancelReason(confirmed("restart")), null);
  // Migration stops the legacy LaunchAgent, not this app, and no executor task is hosted there.
  assert.equal(executorCancelReason(confirmed("migrate")), null);
  // A dropped channel does not mean the app died: the tasks are still running and reconnecting
  // reconciles them. Treating a drop as a stop would cause double writes.
  assert.equal(executorCancelReason({ kind: "device-channel-lost" }), null);
});
