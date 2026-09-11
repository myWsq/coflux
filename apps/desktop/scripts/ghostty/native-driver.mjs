import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
export const addon = require("../../native/ghostty/build/coflux_ghostty.node");
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node 没有 Electron 的 AppKit loop；只在编排者的非沙箱进程中调用 pump。 */
export async function createSurface(width = 800, height = 480) {
  const events = [];
  let destroyed = false, lateCallbacks = 0;
  const id = addon.create(Buffer.alloc(8), 0, 0, width, height, 2, (surfaceId, kind, bytes, x, y) => {
    if (destroyed) lateCallbacks++;
    events.push({ id: surfaceId, kind, bytes: Buffer.from(bytes), x, y });
  });
  const pump = setInterval(() => addon.pump(), 2);
  async function wait(kind, timeout = 15000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const error = events.find((event) => event.kind === 5);
      if (error) throw new Error(error.bytes.toString());
      const index = events.findIndex((event) => event.kind === kind);
      if (index >= 0) return events.splice(index, 1)[0];
      await delay(2);
    }
    throw new Error(`surface ${id}: 等待事件 ${kind} 超时`);
  }
  try { await wait(1); } catch (error) { addon.destroy(id); clearInterval(pump); throw error; }
  return {
    id, events, wait,
    async write(bytes, replay = false) {
      const accepted = (replay ? addon.replay : addon.write)(id, Buffer.from(bytes));
      if (!accepted) throw new Error("原生 write 未接收");
      return wait(6);
    },
    async reset() { addon.reset(id); return wait(9); },
    async frame(width, height) { addon.setFrame(id, 0, 0, width, height, 2); return wait(8); },
    dump: () => addon.dump(id),
    async destroy() {
      destroyed = true; addon.destroy(id);
      // 正在解析的块可能稍后结束，期间继续排空主线程回调。
      await delay(100); clearInterval(pump);
      if (lateCallbacks) throw new Error(`销毁后收到 ${lateCallbacks} 个旧回调`);
    },
  };
}
