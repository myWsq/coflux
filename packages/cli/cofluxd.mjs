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
const DEFAULT_WEB = "https://app.coflux.dev";

const REPO = "myWsq/coflux";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
const BIN_DIR = join(HOME, "bin");
const SETTINGS = join(HOME, "settings.json"); // 用户配置（含一次性登记密钥）→ daemon 直接读；含密钥故 600
const LOG_FILE = join(HOME, "daemon.log");
const CRED = join(HOME, "credentials.json");
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
  if (!settings.enrollKey && !fs.existsSync(CRED)) {
    console.warn("⚠ 无登记密钥且未登记：从 web「添加设备」获取后重跑。");
  }
  installService(!noStart);
  console.log(noStart ? "已安装（未启动）。" : `✓ daemon 已启动 → ${serverUrl}`);
  cmdStatus();
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
  console.log("\n  欢迎使用 coflux —— 配置这台设备\n  ──────────────────────────────\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const serverUrl = (await rl.question(`服务器地址 [${s.serverUrl || DEFAULT_SERVER}]: `)).trim() || s.serverUrl || DEFAULT_SERVER;
    const web = serverUrl === DEFAULT_SERVER ? DEFAULT_WEB : "你的 coflux web 控制台";
    console.log(`\n  → 打开 ${web} 登录 →「添加设备」→ 复制登记密钥\n`);
    const enrollKey = (await rl.question("登记密钥（已登记可留空）: ")).trim();
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
  if (!fs.existsSync(ENV_FILE)) die("尚未安装，先 cofluxd up / onboard");
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"] });
  restartService();
  console.log(`✓ 已更新到 ${v["bin-dir"] ? "本地产物" : v.version} 并重启（supervisor）`);
  console.log("  注：worker 还可由 server 远程热升级，无需停服。");
}

function cmdStatus() {
  const s = readSettings();
  console.log(`服务器: ${s.serverUrl || "(未配置)"}`);
  console.log(`设备名: ${s.deviceName || "(默认)"}`);
  console.log(`凭证:   ${fs.existsSync(CRED) ? "已登记" : "未登记"}`);
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
  cofluxd up [flags]      非交互装/起（web「添加设备」给的命令用这个）
  cofluxd reload          按 ~/.coflux/settings.json 重载并重启
  cofluxd update          更新二进制并重启（worker 另可远程热升级）
  cofluxd status          服务器/登记/服务状态
  cofluxd logs [-f]       看 daemon 日志
  cofluxd down            停止
  cofluxd uninstall [--purge]   卸载（--purge 连二进制/配置/凭证一并删）

up flags: --server <ws://.../daemon>  --enroll-key <KEY>  --name <名>  --shell <路径>
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
