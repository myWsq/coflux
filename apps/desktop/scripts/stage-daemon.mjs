#!/usr/bin/env node
// 内置 daemon 三件的落位脚本（plan 113）：把 coflux-supervisor / coflux-worker / cofluxd 与版本戳 VERSION
// 从一个显式给出的产物目录复制到 build/daemon/——electron-builder.yml 的 extraResources 只认这个固定目录，
// 主进程未打包时也从这里找（src/main/daemon-bundle.ts）。
// 同时（plan 115）把仓库里的 integrations/claude-plugin 整目录逐字节拷到 build/daemon/claude-plugin/，
// 随同一个 extraResources 进 Contents/Resources/daemon/claude-plugin——coflux 终端里的 claude 自动带上的就是它。
//
// 输入（二选一，缺失即失败，绝不静默出一个不带 daemon 的包）：
//   node scripts/stage-daemon.mjs --from <dir>
//   COFLUX_DESKTOP_DAEMON_DIR=<dir> node scripts/stage-daemon.mjs
// <dir> 必须含三件二进制；VERSION 取 <dir>/VERSION，缺失时退到环境变量 COFLUX_DESKTOP_DAEMON_VERSION，
// 再缺失落 "dev"（本机 target/debug 产物编译期就是 dev；主进程对解析不了的内置版本永不提示升级）。
// CI（desktop-release.yml）在 daemon job 里把 v0.0.0-desktop.<桌面版本> 写进 VERSION，与编译期
// COFLUX_RELEASE_VERSION 同一个值。
//
// 复制后统一 chmod 0755：GitHub artifact 不保留执行位，launchd 起不来的二进制比没有更糟。
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
// 与 src/main/daemon-paths.ts 的 DAEMON_BINARIES / DAEMON_VERSION_FILE / CLAUDE_PLUGIN_RESOURCE_DIR 同值；
// test/config.test.ts 守住两边一致
const BINARIES = ["coflux-supervisor", "coflux-worker", "cofluxd"];
const VERSION_FILE = "VERSION";
const CLAUDE_PLUGIN_DIR = "claude-plugin";
// 插件来源在仓库里（不是 CI 的新输入），与三件同一口径：缺失即失败
const CLAUDE_PLUGIN_SOURCE = resolve(REPO_ROOT, "integrations", "claude-plugin");
const CLAUDE_PLUGIN_MANIFEST = resolve(CLAUDE_PLUGIN_SOURCE, ".claude-plugin", "plugin.json");
const STAGE_DIR = resolve(DESKTOP_ROOT, "build", "daemon");

function fail(message) {
  console.error(`✗ stage-daemon: ${message}`);
  process.exit(1);
}

function resolveSourceDir() {
  const index = process.argv.indexOf("--from");
  const fromArg = index >= 0 ? process.argv[index + 1] : undefined;
  const raw = fromArg || process.env.COFLUX_DESKTOP_DAEMON_DIR;
  if (!raw) {
    fail(
      "未指定内置 daemon 产物目录。用 --from <dir> 或环境变量 COFLUX_DESKTOP_DAEMON_DIR 指向含 " +
        `${BINARIES.join(" / ")} 的目录（本机通常是仓库根的 target/debug 或 target/release）。`,
    );
  }
  const dir = resolve(process.cwd(), raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`产物目录不存在或不是目录: ${dir}`);
  return dir;
}

function resolveVersion(sourceDir) {
  const versionPath = resolve(sourceDir, VERSION_FILE);
  if (existsSync(versionPath)) {
    const text = readFileSync(versionPath, "utf8").trim();
    if (!text) fail(`${versionPath} 为空`);
    return text;
  }
  const fromEnv = process.env.COFLUX_DESKTOP_DAEMON_VERSION?.trim();
  if (fromEnv) return fromEnv;
  console.warn("  stage-daemon: 产物目录没有 VERSION、也未设 COFLUX_DESKTOP_DAEMON_VERSION，版本戳落 dev（不会触发升级提示）");
  return "dev";
}

function checkClaudePluginSource() {
  if (!existsSync(CLAUDE_PLUGIN_SOURCE) || !statSync(CLAUDE_PLUGIN_SOURCE).isDirectory()) {
    fail(`插件目录不存在或不是目录: ${CLAUDE_PLUGIN_SOURCE}（仓库内 integrations/claude-plugin）`);
  }
  if (!existsSync(CLAUDE_PLUGIN_MANIFEST)) fail(`插件目录缺少 .claude-plugin/plugin.json: ${CLAUDE_PLUGIN_SOURCE}`);
}

const sourceDir = resolveSourceDir();
checkClaudePluginSource();
const missing = BINARIES.filter((name) => {
  const path = resolve(sourceDir, name);
  return !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0;
});
if (missing.length > 0) fail(`产物目录 ${sourceDir} 缺少或为空: ${missing.join(", ")}`);
const version = resolveVersion(sourceDir);

// STAGE_DIR 是常量路径（apps/desktop/build/daemon），不是可能为空的变量
rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });
for (const name of BINARIES) {
  const target = resolve(STAGE_DIR, name);
  copyFileSync(resolve(sourceDir, name), target);
  chmodSync(target, 0o755);
}
writeFileSync(resolve(STAGE_DIR, VERSION_FILE), `${version}\n`);
// 插件整目录原样拷（.claude-plugin / hooks / scripts / skills / README / LICENSE 全带，
// 一个字节都不改写，不产生第二份插件变体）。脚本经 sh / node 调用，不需要执行位，
// 也不进 mac.binaries（不是 Mach-O）。
cpSync(CLAUDE_PLUGIN_SOURCE, resolve(STAGE_DIR, CLAUDE_PLUGIN_DIR), { recursive: true });
console.log(
  `✓ stage-daemon: ${BINARIES.join(", ")} + ${VERSION_FILE}(${version}) ← ${sourceDir} → ${STAGE_DIR}\n` +
    `✓ stage-daemon: ${CLAUDE_PLUGIN_DIR}/ ← ${CLAUDE_PLUGIN_SOURCE}`,
);
