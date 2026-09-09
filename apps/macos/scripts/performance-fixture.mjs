/** 性能测量固定使用优化后的 Rust 三端，避免误用 Debug daemon 的快照成本。 */
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const [key, binary] of [
  ['COFLUX_SUPERVISOR_BIN', 'coflux-supervisor'],
  ['COFLUX_WORKER_BIN', 'coflux-worker'],
  ['COFLUX_RELAY_BIN', 'coflux-relay'],
]) {
  const path = fileURLToPath(new URL(`../../../target/release/${binary}`, import.meta.url));
  try { accessSync(path, constants.X_OK); }
  catch { throw new Error(`缺少可执行的 Release 产物 ${path}；先运行 cargo build --release -p coflux-supervisor -p coflux-worker -p coflux-relay`); }
  process.env[key] = path;
}
process.env.COFLUX_NATIVE_BACKEND_PROFILE = 'release';
// harness在模块加载时读取二进制路径，必须在配置完成后动态加载。
await import('./dev-fixture.mjs');
