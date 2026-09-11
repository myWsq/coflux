import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { addon, createSurface } from "./native-driver.mjs";
const rounds = Number(process.argv[2] ?? 50);
assert.ok(Number.isInteger(rounds) && rounds >= 50);
const payload = Buffer.from(("持续输出 👨‍👩‍👧 🇯🇵 👋🏽 e\u0301\r\n").repeat(512));
const started = performance.now();
let peakRss = 0;
for (let round = 0; round < rounds; round++) {
  const surface = await createSurface();
  try {
    // 每轮持续输出；最后一块接收后立即关闭，覆盖解析/回调尚未完成的销毁。
    for (let chunk = 0; chunk < 12; chunk++) await surface.write(payload);
    assert.equal(addon.write(surface.id, payload), true);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  } finally { await surface.destroy(); }
  console.log(`round=${round + 1} created/written/destroyed`);
}
console.log(JSON.stringify({ gate: "G2", rounds, peakRss, durationMs: performance.now() - started, pid: process.pid }));
