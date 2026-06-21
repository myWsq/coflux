/**
 * node-pty 的 prebuild 在被 pnpm 解压后，darwin 的 `spawn-helper` 会丢失可执行位，
 * 导致运行时 `posix_spawnp failed`。这里在每次 install 后补回执行位。
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pnpmDir = join(root, "node_modules", ".pnpm");

if (!existsSync(pnpmDir)) process.exit(0);

let fixed = 0;
for (const entry of readdirSync(pnpmDir)) {
  if (!entry.startsWith("node-pty@")) continue;
  const prebuilds = join(pnpmDir, entry, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) continue;
  for (const plat of readdirSync(prebuilds)) {
    const helper = join(prebuilds, plat, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111); // +x for u/g/o
      fixed++;
    } catch {
      /* ignore */
    }
  }
}

if (fixed > 0) console.log(`[fix-pty-perms] chmod +x on ${fixed} spawn-helper binary(ies)`);
