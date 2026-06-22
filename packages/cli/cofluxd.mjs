#!/usr/bin/env node
// cofluxd —— coflux daemon 管理 CLI。
// daemon 是两个 Rust 二进制（supervisor 持 PTY + worker 频繁热升级，零 node 运行时）；
// 本 CLI 只负责装/起/停/升级（用一下，不常驻）。systemd(Linux user) / launchd(macOS LaunchAgent)。
import { parseArgs } from "node:util";
import { homedir, hostname, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REPO = "myWsq/coflux";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
const BIN_DIR = join(HOME, "bin");
const ENV_FILE = join(HOME, "daemon.env");
const WRAPPER = join(HOME, "run-daemon.sh");
const LOG_FILE = join(HOME, "daemon.log");
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

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* 无配置 */ }
  return out;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) die(`下载失败 HTTP ${res.status}: ${url}\n（该版本/平台的 release 资产是否已发布？）`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
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
  const base = version === "latest" ? `https://github.com/${REPO}/releases/latest/download` : `https://github.com/${REPO}/releases/download/${version}`;
  for (const b of ["coflux-supervisor", "coflux-worker"]) {
    process.stdout.write(`下载 ${b}-${t} … `);
    await download(`${base}/${b}-${t}`, join(BIN_DIR, b));
    console.log("✓");
  }
}

function writeConfig({ server, enrollKey, name }) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.chmodSync(HOME, 0o700);
  const old = readEnv();
  const env = {
    COFLUX_SERVER: server || old.COFLUX_SERVER || "ws://localhost:8787/daemon",
    COFLUX_ENROLL_KEY: enrollKey ?? old.COFLUX_ENROLL_KEY ?? "",
    COFLUX_DEVICE_NAME: name || old.COFLUX_DEVICE_NAME || hostname(),
    COFLUX_HOME: HOME,
    COFLUX_WORKER_CMD: WRK_BIN,
    COFLUX_WORKER_ARGS: "[]",
  };
  fs.writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(WRAPPER, `#!/bin/sh\nset -a\n[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"\nset +a\nexec "${SUP_BIN}"\n`, { mode: 0o700 });
  return env;
}

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${WRAPPER}</string></array>
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
ExecStart=${WRAPPER}
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

/* ------------------------------ 命令 ------------------------------ */

async function cmdUp(v) {
  const env0 = readEnv();
  if (!v.server && !env0.COFLUX_SERVER) die("首次启用需 --server <ws://你的服务器/daemon>");
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"] });
  const env = writeConfig({ server: v.server, enrollKey: v["enroll-key"], name: v.name });
  if (!env.COFLUX_ENROLL_KEY && !fs.existsSync(join(HOME, "credentials.json"))) {
    console.warn("⚠ 未提供 --enroll-key 且无已存凭证：daemon 将无法登记。从 web「添加设备」获取登记密钥后重跑。");
  }
  installService(!v["no-start"]);
  console.log(v["no-start"] ? "已安装（未启动）。" : `✓ daemon 已启动，连接 ${env.COFLUX_SERVER}`);
  console.log(`  状态: cofluxd status   日志: cofluxd logs`);
}

function cmdDown() { stopService(); console.log("✓ 已停止"); }

async function cmdUpdate(v) {
  if (!fs.existsSync(ENV_FILE)) die("尚未安装，先 cofluxd up");
  await ensureBinaries({ version: v.version, binDir: v["bin-dir"] });
  restartService();
  console.log(`✓ 已更新到 ${v["bin-dir"] ? "本地产物" : v.version} 并重启（supervisor）`);
  console.log("  注：worker 还可由 server 远程热升级，无需停服。");
}

function cmdStatus() {
  const env = readEnv();
  console.log(`服务器: ${env.COFLUX_SERVER || "(未配置)"}`);
  console.log(`设备名: ${env.COFLUX_DEVICE_NAME || "(默认)"}`);
  console.log(`凭证:   ${fs.existsSync(join(HOME, "credentials.json")) ? "已登记" : "未登记"}`);
  let running = false, active = "未知";
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
    run("tail", [v.follow ? "-f" : "-n", v.follow ? LOG_FILE : "100", ...(v.follow ? [] : [LOG_FILE])], { stdio: "inherit" });
  } else if (IS_LINUX) {
    run("journalctl", ["--user", "-u", "coflux-daemon.service", v.follow ? "-f" : "-n", v.follow ? "" : "100"].filter(Boolean), { stdio: "inherit" });
  }
}

function cmdUninstall(v) {
  stopService();
  for (const f of [IS_MAC ? PLIST : UNIT, WRAPPER, ENV_FILE]) { try { fs.rmSync(f); } catch { /* */ } }
  if (IS_LINUX) run("systemctl", ["--user", "daemon-reload"]);
  if (v.purge) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } console.log("✓ 已卸载并清除 " + HOME); }
  else console.log(`✓ 已卸载服务（保留二进制与凭证于 ${HOME}；--purge 可全清）`);
}

const HELP = `cofluxd —— coflux daemon 管理

  cofluxd up --server <ws://.../daemon> --enroll-key <KEY> [--name <名>]
                          装/起 daemon（系统服务，崩溃自启）。从 web「添加设备」拿密钥。
  cofluxd update          更新二进制并重启 supervisor（worker 另可远程热升级）
  cofluxd status          查看服务器/登记/服务状态
  cofluxd logs [-f]       看 daemon 日志
  cofluxd down            停止
  cofluxd uninstall [--purge]   卸载服务（--purge 连二进制/凭证一并删）

通用选项: --version <vX|latest>（默认 latest）  --bin-dir <dir>（用本地 cargo 产物，开发者）  --no-start`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    "enroll-key": { type: "string" },
    name: { type: "string" },
    version: { type: "string", default: "latest" },
    "bin-dir": { type: "string" },
    "no-start": { type: "boolean", default: false },
    purge: { type: "boolean", default: false },
    follow: { type: "boolean", short: "f", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const cmd = positionals[0];
if (values.help || !cmd || cmd === "help") { console.log(HELP); process.exit(0); }

const handlers = { up: cmdUp, update: cmdUpdate, down: cmdDown, status: cmdStatus, logs: cmdLogs, uninstall: cmdUninstall };
const h = handlers[cmd];
if (!h) die(`未知命令: ${cmd}\n\n${HELP}`);
await h(values);
