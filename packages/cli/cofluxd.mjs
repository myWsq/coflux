#!/usr/bin/env node
// cofluxd —— coflux daemon 管理 CLI。
// daemon 是两个 Rust 二进制（supervisor 持 PTY + worker 频繁热升级，零 node 运行时）；
// 本 CLI 只负责装/起/停/升级（用一下，不常驻）。systemd(Linux user) / launchd(macOS LaunchAgent)。
import { parseArgs } from "node:util";
import { homedir, hostname, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// 默认中心服务（公共 SaaS）；自托管用 --server 覆盖。
const DEFAULT_SERVER = "wss://api.coflux.dev/daemon";

const REPO = "myWsq/coflux";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
const BIN_DIR = join(HOME, "bin");
const SETTINGS = join(HOME, "settings.json"); // 用户配置（含一次性登记密钥）→ daemon 直接读；含密钥故 600
const LOG_FILE = join(HOME, "daemon.log");
const CRED = join(HOME, "credentials.json");
const PENDING_AUTH = join(HOME, "pending-auth.json"); // worker 落盘的待授权链接（daemon.authorizePending）
const SUP_BIN = join(BIN_DIR, "coflux-supervisor");
const WRK_BIN = join(BIN_DIR, "coflux-worker");
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";
const PLIST = join(homedir(), "Library", "LaunchAgents", "com.coflux.daemon.plist");
const UNIT = join(homedir(), ".config", "systemd", "user", "coflux-daemon.service");

const die = (m) => { console.error("✗ " + m); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

function rustTarget() {
  const p = platform(), a = arch();
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  die(`不支持的平台: ${p}/${a}（仅 macOS / Linux）`);
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; }
}

function readPendingAuth() {
  try { return JSON.parse(fs.readFileSync(PENDING_AUTH, "utf8")); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) die(`下载失败 HTTP ${res.status}: ${url}\n（该版本/平台的 release 资产是否已发布？）`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
}
// 取最新 release tag（含 prerelease；GitHub 的 /releases/latest 跳转不含 prerelease，故走 API）。
async function resolveLatestTag() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
      headers: { "user-agent": "cofluxd", accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    const arr = await r.json();
    return Array.isArray(arr) && arr[0]?.tag_name ? arr[0].tag_name : null;
  } catch {
    return null;
  }
}

async function ensureBinaries({ version, binDir }) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (binDir) {
    for (const b of ["coflux-supervisor", "coflux-worker"]) {
      const src = join(binDir, b);
      if (!fs.existsSync(src)) die(`本地产物缺失: ${src}（先 cargo build --release？）`);
      fs.copyFileSync(src, join(BIN_DIR, b));
      fs.chmodSync(join(BIN_DIR, b), 0o755);
    }
    console.log(`✓ 用本地二进制（${binDir}）`);
    return;
  }
  const t = rustTarget();
  let base;
  if (version === "latest") {
    const tag = await resolveLatestTag();
    if (tag) console.log(`最新版本: ${tag}`);
    base = tag ? `https://github.com/${REPO}/releases/download/${tag}` : `https://github.com/${REPO}/releases/latest/download`;
  } else {
    base = `https://github.com/${REPO}/releases/download/${version}`;
  }
  for (const b of ["coflux-supervisor", "coflux-worker"]) {
    process.stdout.write(`下载 ${b}-${t} … `);
    await download(`${base}/${b}-${t}`, join(BIN_DIR, b));
    console.log("✓");
  }
}

// 写 settings.json（daemon 直接读；含一次性登记密钥 → 600）。未提供 enrollKey 时保留旧值。
function applyConfig({ serverUrl, enrollKey, deviceName, shell }) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.chmodSync(HOME, 0o700);
  const old = readSettings();
  const settings = { serverUrl, deviceName, enrollKey: enrollKey || old.enrollKey || "" };
  if (shell) settings.shell = shell;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return settings;
}

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${SUP_BIN}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>COFLUX_HOME</key><string>${HOME}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`;
}
function systemdUnit() {
  return `[Unit]
Description=coflux daemon (supervisor)
After=network-online.target
Wants=network-online.target

[Service]
Environment=COFLUX_HOME=${HOME}
ExecStart=${SUP_BIN}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}
function installService(start) {
  if (IS_MAC) {
    fs.mkdirSync(dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plistXml());
    if (start) { run("launchctl", ["unload", PLIST]); run("launchctl", ["load", PLIST]); }
    console.log(`✓ launchd: ${PLIST}`);
  } else if (IS_LINUX) {
    fs.mkdirSync(dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, systemdUnit());
    if (start) { run("systemctl", ["--user", "daemon-reload"]); run("systemctl", ["--user", "enable", "--now", "coflux-daemon.service"]); }
    console.log(`✓ systemd: ${UNIT}`);
  } else die("仅支持 macOS / Linux");
}
function restartService() {
  if (IS_MAC) { run("launchctl", ["unload", PLIST]); run("launchctl", ["load", PLIST]); }
  else if (IS_LINUX) run("systemctl", ["--user", "restart", "coflux-daemon.service"]);
}
function stopService() {
  if (IS_MAC) run("launchctl", ["unload", PLIST]);
  else if (IS_LINUX) run("systemctl", ["--user", "stop", "coflux-daemon.service"]);
}

async function applyAndStart({ serverUrl, enrollKey, deviceName, shell, version, binDir, noStart }) {
  await ensureBinaries({ version, binDir });
  const settings = applyConfig({ serverUrl, enrollKey, deviceName, shell });
  // 非默认服务器醒目提示：保存值/--server 仍生效（不强制覆盖），但防止 staging 之类残留值静默错连。
  if (serverUrl !== DEFAULT_SERVER) {
    console.log(`⚠ 使用非默认服务器: ${serverUrl}`);
  }
  installService(!noStart);
  console.log(noStart ? "已安装（未启动）。" : `✓ daemon 已启动 → ${serverUrl}`);
  if (!noStart && !settings.enrollKey && !fs.existsSync(CRED)) {
    // 默认流程（零参数 up）：无登记密钥、未登记 → 走浏览器授权，轮询 daemon 落盘的链接/凭证文件。
    await waitForAuthorization();
  } else {
    cmdStatus();
  }
}

// 轮询 ~/.coflux/pending-auth.json（授权链接）与 credentials.json（登记成功）给出全程反馈。
// CLI 保持零协议：只读文件，不连 WS；daemon 断线重连会自动重发 enrollRequest、换发新链接。
async function waitForAuthorization() {
  console.log("\n  等待设备授权 …\n");
  const maxWaitMs = 11 * 60 * 1000; // 只是前台等待的上限；daemon 会持续自动续期授权链接，超时后用 status 看最新链接即可
  const start = Date.now();
  let printedUrl = null;
  while (Date.now() - start < maxWaitMs) {
    if (fs.existsSync(CRED)) {
      console.log("✓ 设备已登记\n");
      cmdStatus();
      return;
    }
    const pending = readPendingAuth();
    if (pending?.url && pending.url !== printedUrl) {
      printedUrl = pending.url;
      const mins = Number.isFinite(pending.expiresAt) ? Math.max(1, Math.round((pending.expiresAt - Date.now()) / 60000)) : null;
      console.log(`  在浏览器打开以下链接，用已登录账号授权此设备${mins ? `（约 ${mins} 分钟内有效）` : ""}：\n`);
      console.log(`    ${pending.url}\n`);
    }
    await sleep(1000);
  }
  // 链接会过期换新（daemon 自动续期），别引导用户用"上面的链接"——过期后那是死链
  console.log("  仍未完成授权；daemon 已在后台运行并会自动更换过期的授权链接，用 `cofluxd status` 查看最新链接。\n");
}

/* ------------------------------ 命令 ------------------------------ */

async function cmdUp(v) {
  const s = readSettings();
  await applyAndStart({
    serverUrl: v.server || s.serverUrl || DEFAULT_SERVER,
    enrollKey: v["enroll-key"],
    deviceName: v.name || s.deviceName || hostname(),
    shell: v.shell || s.shell,
    version: v.version, binDir: v["bin-dir"], noStart: v["no-start"],
  });
}

async function cmdOnboard(v) {
  const s = readSettings();
  // 服务器地址不再交互询问（用户拍板 2026-07-04）：--server > 已保存值 > 默认公共服务；
  // 优先级与 cmdUp 一致（见 packages/cli/cofluxd.mjs 里 applyAndStart 的非默认提示）。
  const serverUrl = v.server || s.serverUrl || DEFAULT_SERVER;
  console.log("\n  欢迎使用 coflux —— 配置这台设备\n  ──────────────────────────────\n");
  console.log(`  服务器: ${serverUrl}\n`);
  console.log("  登记方式：留空走浏览器授权（推荐，起服务后打印链接，登录确认即可）；\n  已有登记密钥可直接粘贴。\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const enrollKey = (v["enroll-key"] ?? (await rl.question("登记密钥（可留空）: "))).trim();
    const deviceName = (await rl.question(`设备名 [${s.deviceName || hostname()}]: `)).trim() || s.deviceName || hostname();
    rl.close();
    console.log("");
    await applyAndStart({ serverUrl, enrollKey, deviceName, shell: s.shell, version: v.version, binDir: v["bin-dir"], noStart: v["no-start"] });
  } finally {
    rl.close();
  }
}

function cmdReload() {
  if (!fs.existsSync(SETTINGS)) die("无 settings.json，先 cofluxd up 或 cofluxd onboard");
  restartService(); // daemon 重启时重新读 settings.json
  console.log("✓ 已重启（daemon 重新读取 settings.json）");
}

function cmdDown() { stopService(); console.log("✓ 已停止"); }

async function cmdUpdate(v) {
  if (!fs.existsSync(SETTINGS)) die("尚未安装，先 cofluxd up / onboard");
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"] });
  restartService();
  console.log(`✓ 已更新到 ${v["bin-dir"] ? "本地产物" : v.version} 并重启（supervisor）`);
  console.log("  注：worker 还可由 server 远程热升级，无需停服。");
}

function cmdStatus() {
  const s = readSettings();
  console.log(`服务器: ${s.serverUrl || "(未配置)"}`);
  console.log(`设备名: ${s.deviceName || "(默认)"}`);
  const registered = fs.existsSync(CRED);
  const pending = !registered ? readPendingAuth() : null;
  if (registered) {
    console.log("凭证:   已登记");
  } else if (pending?.url) {
    const mins = Number.isFinite(pending.expiresAt) ? Math.max(0, Math.round((pending.expiresAt - Date.now()) / 60000)) : null;
    console.log(`凭证:   等待授权${mins !== null ? `（约 ${mins} 分钟内有效）` : ""}`);
    console.log(`        ${pending.url}`);
  } else {
    console.log("凭证:   未登记");
  }
  let running = false, active = "未运行";
  if (IS_MAC) {
    running = run("launchctl", ["list", "com.coflux.daemon"]).status === 0;
    active = running ? "运行中" : "未运行";
  } else if (IS_LINUX) {
    active = (run("systemctl", ["--user", "is-active", "coflux-daemon.service"]).stdout || "").trim() || "未运行";
    running = active === "active";
  }
  let pid = "";
  if (running) {
    try { pid = ` (worker pid ${fs.readFileSync(join(HOME, "worker.pid"), "utf8").trim()})`; } catch { /* */ }
  }
  console.log(`服务:   ${active}${pid}`);
}

function cmdLogs(v) {
  if (IS_MAC) {
    if (!fs.existsSync(LOG_FILE)) die(`暂无日志 ${LOG_FILE}`);
    run("tail", v.follow ? ["-f", LOG_FILE] : ["-n", "100", LOG_FILE], { stdio: "inherit" });
  } else if (IS_LINUX) {
    run("journalctl", ["--user", "-u", "coflux-daemon.service", ...(v.follow ? ["-f"] : ["-n", "100"])], { stdio: "inherit" });
  }
}

function cmdUninstall(v) {
  stopService();
  try { fs.rmSync(IS_MAC ? PLIST : UNIT); } catch { /* */ }
  if (IS_LINUX) run("systemctl", ["--user", "daemon-reload"]);
  if (v.purge) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } console.log("✓ 已卸载并清除 " + HOME); }
  else console.log(`✓ 已卸载服务（保留二进制/配置/凭证于 ${HOME}；--purge 可全清）`);
}

const HELP = `cofluxd —— coflux daemon 管理

  cofluxd                 首次=交互式配置(onboard)，已配置=status
  cofluxd onboard         交互式配置并启用
  cofluxd up [flags]      非交互装/起，零参数即可（不带 --enroll-key 时打印浏览器授权链接）
  cofluxd reload          按 ~/.coflux/settings.json 重载并重启
  cofluxd update          更新二进制并重启（worker 另可远程热升级）
  cofluxd status          服务器/登记（含"等待授权"）/服务状态
  cofluxd logs [-f]       看 daemon 日志
  cofluxd down            停止
  cofluxd uninstall [--purge]   卸载（--purge 连二进制/配置/凭证一并删）

up flags: --server <ws://.../daemon>  --enroll-key <KEY>（留空则走浏览器授权）  --name <名>  --shell <路径>
通用: --version <vX|latest>(默认 latest)  --bin-dir <dir>(用本地 cargo 产物)  --no-start
配置都在 ~/.coflux/settings.json（serverUrl/enrollKey/deviceName/shell，含密钥故 600），daemon 直接读；改后 cofluxd reload 生效。`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    "enroll-key": { type: "string" },
    name: { type: "string" },
    shell: { type: "string" },
    version: { type: "string", default: "latest" },
    "bin-dir": { type: "string" },
    "no-start": { type: "boolean", default: false },
    purge: { type: "boolean", default: false },
    follow: { type: "boolean", short: "f", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

let cmd = positionals[0];
if (values.help || cmd === "help") { console.log(HELP); process.exit(0); }
if (!cmd) cmd = fs.existsSync(SETTINGS) ? "status" : "onboard"; // 首次裸跑 → 引导

const handlers = { up: cmdUp, onboard: cmdOnboard, reload: cmdReload, update: cmdUpdate, down: cmdDown, status: cmdStatus, logs: cmdLogs, uninstall: cmdUninstall };
const h = handlers[cmd];
if (!h) die(`未知命令: ${cmd}\n\n${HELP}`);
await h(values);
