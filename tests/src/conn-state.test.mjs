import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startStack } from "./harness.mjs";

// plan 033：worker 把连接状态落盘到 $COFLUX_HOME/conn-state.json，供 cofluxd status 展示真实
// 在线态（而非只看进程存活）。本测试验证状态机随真实连接事件迁移：connected → server 断线
// → reconnecting → server 恢复 → 重新 connected，且 lastAuthed 随重新 authed 前进。
const PORT = 8837;
let stack;

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); });

function readConnState() {
  try { return JSON.parse(readFileSync(join(stack.home, "conn-state.json"), "utf8")); } catch { return null; }
}

async function waitConnState(pred, label, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = readConnState();
    if (s && pred(s)) return s;
    await sleep(100);
  }
  throw new Error(`timeout waiting conn-state: ${label} (last=${JSON.stringify(readConnState())})`);
}

test("conn-state.json 随连接状态机变迁：connected → server 断线 → reconnecting → 恢复 → connected", async () => {
  const connected1 = await waitConnState((s) => s.state === "connected", "初始 connected");
  assert.ok(Number.isFinite(connected1.lastAuthed), "已记录首次 authed 时间戳");

  // 不 await：先让 server 立刻被杀掉，趁 daemon 察觉断线的窗口去读 reconnecting，
  // 再等 restartServer() 把新 server 起来、daemon 重新连上。
  const restarting = stack.restartServer();
  await waitConnState((s) => s.state === "reconnecting", "server 断线后转 reconnecting");
  await restarting;

  const connected2 = await waitConnState((s) => s.state === "connected", "server 恢复后重连回 connected", 20000);
  assert.ok(connected2.lastAuthed >= connected1.lastAuthed, "lastAuthed 随重新 authed 前进");
});
