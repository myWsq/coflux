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
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

// 默认中心服务（公共 SaaS）；自托管用 --server 覆盖。
const DEFAULT_SERVER = "wss://api.coflux.dev/daemon";

const REPO = "myWsq/coflux";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
const BIN_DIR = join(HOME, "bin");
const SETTINGS = join(HOME, "settings.json"); // 用户配置（serverUrl/deviceName/shell）→ daemon 直接读；600 权限防同机其他用户窥探
const LOG_FILE = join(HOME, "daemon.log");
const CRED = join(HOME, "credentials.json");
const PENDING_AUTH = join(HOME, "pending-auth.json"); // worker 落盘的待授权链接（daemon.authorizePending）
const CONN_STATE = join(HOME, "conn-state.json"); // worker 落盘的连接态快照（plan 033，见 crates/worker/src/conn_state.rs）
const LOCAL_GATEWAY_STORE = join(HOME, "local-gateway.json"); // gateway key/origin/grant；doctor 只读结构与数量，绝不打印秘密
const FDA_STATUS = join(HOME, "fda-status"); // supervisor 启动时探测落盘（仅 macOS，见 crates/supervisor/src/fda.rs）
const SUP_BIN = join(BIN_DIR, "coflux-supervisor");
const WRK_BIN = join(BIN_DIR, "coflux-worker");
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";
const PLIST = join(homedir(), "Library", "LaunchAgents", "com.coflux.daemon.plist");
const UNIT = join(homedir(), ".config", "systemd", "user", "coflux-daemon.service");
const DEFAULT_LOCAL_GATEWAY_PORT = 8788; // 与 packages/crates protocol 的 LOCAL_GATEWAY_PORT 保持一致

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

function readConnState() {
  try { return JSON.parse(fs.readFileSync(CONN_STATE, "utf8")); } catch { return null; }
}

function readLocalGatewaySummary() {
  let store;
  try { store = JSON.parse(fs.readFileSync(LOCAL_GATEWAY_STORE, "utf8")); }
  catch {
    return {
      ok: false,
      ready: false,
      // JSON.parse 的错误在部分 Node 版本会带原文片段；store 含私钥，诊断输出绝不能回显。
      error: fs.existsSync(LOCAL_GATEWAY_STORE) ? "grant store 无法解析" : "grant store 尚未创建",
    };
  }
  if (store?.version !== 1 || !Array.isArray(store.origins) || !Array.isArray(store.grants)) {
    return { ok: false, ready: false, error: "grant store 结构/版本无效" };
  }
  const origins = store.origins.filter((origin) => typeof origin === "string" && origin.length > 0);
  const grants = store.grants.filter((grant) => grant && typeof grant.origin === "string" && grant.origin.length > 0);
  const origin = grants.find((grant) => origins.includes(grant.origin))?.origin || origins[0];
  const ready = grants.length > 0 && !!origin;
  const summary = ready
    ? `${grants.length} 个持久 grant / ${origins.length} 个 Origin`
    : `${grants.length} 个 grant / ${origins.length} 个 Origin（尚无可用浏览器配对）`;
  return {
    ok: ready,
    ready,
    origin,
    detail: ready ? summary : undefined,
    error: ready ? undefined : summary,
  };
}

function localGatewayPort() {
  const raw = process.env.COFLUX_LOCAL_GATEWAY_PORT;
  if (raw === undefined || raw === "") return { ok: true, port: DEFAULT_LOCAL_GATEWAY_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `COFLUX_LOCAL_GATEWAY_PORT=${raw} 无法定位固定监听端口` };
  }
  return { ok: true, port };
}
const CONN_STATE_LABEL = { connecting: "连接中", connected: "已连接", reconnecting: "重连中" };
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分钟`;
}

// "granted" | "denied" | "unknown" | null（文件不存在——supervisor 还没起过/还没写）
function readFdaStatus() {
  try { return fs.readFileSync(FDA_STATUS, "utf8").trim(); } catch { return null; }
}
function fdaLabel(status) {
  return status === "granted" ? "已授予" : status === "denied" ? "未授予" : "未知";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileSha256(path) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"); } catch { return null; }
}

// macOS：新落盘的二进制带 com.apple.provenance，launchd 顶层 spawn 会被 AMFI 以
// OS_REASON_CODESIGNING 静默杀死——即使产物是 Developer ID 签名 + 已公证（2026-07-25
// v0.13.0 实测仍被连杀）。本地 ad-hoc 重签使其成为"本机产物"绕开该检查；签名威胁模型
// 不受影响（防的是中心被攻破推恶意产物，靠下载后的 sha256+ed25519 验签，与此无关）。
function resignMacBinaries(paths) {
  if (!IS_MAC) return;
  for (const p of paths) {
    const r = run("codesign", ["--force", "-s", "-", p]);
    if (r.status !== 0) console.warn(`⚠ 本地重签失败: ${p}（daemon 若被系统杀，手动 codesign --force -s - 该文件后 cofluxd restart）`);
  }
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

// skipIfPresent：up 的幂等语义——二进制已存在且调用方未显式传 version 时跳过下载，
// 避免重跑 up 变成隐式升级（用户拍板，见 plan 035 Decisions）。update/--bin-dir/显式 --version 不受影响。
async function ensureBinaries({ version, binDir, skipIfPresent }) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (binDir) {
    for (const b of ["coflux-supervisor", "coflux-worker"]) {
      const src = join(binDir, b);
      if (!fs.existsSync(src)) die(`本地产物缺失: ${src}（先 cargo build --release？）`);
      fs.copyFileSync(src, join(BIN_DIR, b));
      fs.chmodSync(join(BIN_DIR, b), 0o755);
    }
    resignMacBinaries([SUP_BIN, WRK_BIN]);
    console.log(`✓ 用本地二进制（${binDir}）`);
    return;
  }
  if (skipIfPresent && !version && fs.existsSync(SUP_BIN) && fs.existsSync(WRK_BIN)) {
    console.log(`✓ 二进制已存在（${BIN_DIR}），跳过下载（用 cofluxd update 升级）`);
    return;
  }
  const t = rustTarget();
  let base;
  if (!version || version === "latest") {
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
  resignMacBinaries([SUP_BIN, WRK_BIN]);
}

// 写 settings.json（daemon 直接读）。
function applyConfig({ serverUrl, deviceName, shell }) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.chmodSync(HOME, 0o700);
  const settings = { serverUrl, deviceName };
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

async function applyAndStart({ serverUrl, deviceName, shell, version, binDir, noStart }) {
  await ensureBinaries({ version, binDir, skipIfPresent: true });
  applyConfig({ serverUrl, deviceName, shell });
  // 非默认服务器醒目提示：保存值/--server 仍生效（不强制覆盖），但防止 staging 之类残留值静默错连。
  if (serverUrl !== DEFAULT_SERVER) {
    console.log(`⚠ 使用非默认服务器: ${serverUrl}`);
  }
  installService(!noStart);
  console.log(noStart ? "已安装（未启动）。" : `✓ daemon 已启动 → ${serverUrl}`);
  if (!noStart && !fs.existsSync(CRED)) {
    // 未登记 → 走浏览器授权，轮询 daemon 落盘的链接/凭证文件。
    await waitForAuthorization();
  } else {
    cmdStatus();
  }
  if (IS_MAC && !noStart && readFdaStatus() !== "granted") {
    console.log("\n⚠ 完全磁盘访问权限尚未授予：PTY 里访问桌面/文稿/下载等目录时，系统弹窗可能因无人点击而卡住。");
    console.log("  运行 `cofluxd fda` 完成一次性授权（授予后需重启服务生效）。");
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
    deviceName: v.name || s.deviceName || hostname(),
    shell: v.shell || s.shell,
    version: v.version, binDir: v["bin-dir"], noStart: v["no-start"],
  });
}

function cmdDown() { stopService(); console.log("✓ 已停止"); }

// 只有 supervisor 真正靠这条命令更新——它不自动升级（持 PTY，重启会杀会话，见 plan 017）。
// worker 运行中会被 server 自动热升级到最新 stable（无需停服）；这里顺带刷新的是 worker 的
// "内置兜底二进制"（supervisor 冷启动/热升级缓存皆无时的 fallback），日常可不管。
//
// update 与 restart 拆开（2026-07-25 用户拍板）：update 只落盘二进制、绝不重启——替换磁盘
// 文件对运行中的 supervisor/PTY 零影响；supervisor 内容没变就明说不用重启（大多数发版
// 都不动 supervisor，旧行为等于白丢一次全部会话）。真正的中断收敛到显式的 `cofluxd restart`。
async function cmdUpdate(v) {
  if (!fs.existsSync(SETTINGS)) die("尚未安装，先 cofluxd up");
  const version = v.version || "latest";
  const before = fileSha256(SUP_BIN);
  await ensureBinaries({ version, binDir: v["bin-dir"] });
  if (before === fileSha256(SUP_BIN)) {
    console.log("✓ 已更新：supervisor 无变化——不需要重启，活会话不受影响");
    console.log("  worker 由 server 自动热升级；本次刷新的只是兜底 worker 二进制。");
  } else {
    console.log(`✓ 新 supervisor 已就位（${v["bin-dir"] ? "本地产物" : version}），但尚未生效`);
    console.log("  ⚠ 运行 `cofluxd restart` 应用——会重启 daemon 并结束本机所有活会话（PTY 随 supervisor 退出）。");
  }
}

// 唯一会主动中断会话的命令：应用已就位的新 supervisor（或单纯重启 daemon）。
function cmdRestart() {
  if (!fs.existsSync(SETTINGS)) die("尚未安装，先 cofluxd up");
  console.log("⚠ 正在重启 daemon：本机所有活会话将结束（PTY 随 supervisor 退出）…");
  restartService();
  console.log("✓ 已重启（cofluxd status 查看状态）");
}

// launchd(macOS) / systemd --user(Linux) 服务活跃态查询，status 与 doctor 共用。
// macOS 必须以 launchctl list 输出里的 PID 为准：label 登记 ≠ 进程存活（supervisor 被
// OS_REASON_CODESIGNING 杀掉时 label 仍在，旧实现会报假"运行中"，2026-07-25 实测踩过）。
function serviceRunningInfo() {
  if (IS_MAC) {
    const out = run("launchctl", ["list", "com.coflux.daemon"]);
    const registered = out.status === 0;
    const running = registered && /"PID"\s*=\s*\d+/.test(out.stdout || "");
    return { running, active: running ? "运行中" : registered ? "已登记但进程不在（看 cofluxd logs；常见于系统拒签杀进程）" : "未运行" };
  }
  if (IS_LINUX) {
    const active = (run("systemctl", ["--user", "is-active", "coflux-daemon.service"]).stdout || "").trim() || "未运行";
    return { running: active === "active", active };
  }
  return { running: false, active: "未运行" };
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
  const { running, active } = serviceRunningInfo();
  let pid = "";
  if (running) {
    try { pid = ` (worker pid ${fs.readFileSync(join(HOME, "worker.pid"), "utf8").trim()})`; } catch { /* */ }
  }
  console.log(`服务:   ${active}${pid}`);
  // conn-state.json 是 worker 生前写的快照：进程不在时是 stale 数据，忽略——不能让"进程活着"
  // 误当成"在线"，也不能让 stale 文件在进程死后继续显示假的连接态。
  if (running) {
    const conn = readConnState();
    if (conn?.state && CONN_STATE_LABEL[conn.state]) {
      const dur = Number.isFinite(conn.since) ? formatDuration(Date.now() - conn.since) : null;
      console.log(`连接:   ${CONN_STATE_LABEL[conn.state]}${dur ? `（已 ${dur}）` : ""}`);
    }
  }
  if (IS_MAC) {
    const fda = readFdaStatus();
    const hint = fda === "granted" ? "" : "（`cofluxd fda` 引导授权，避免弹窗卡住 PTY 会话）";
    console.log(`FDA:    ${fdaLabel(fda)}${hint}`);
  }
}

/* ------------------------------ doctor：中心 + 本地直连分层自检 ------------------------------ */
// 中心与 loopback 都只做传输层探测，不解析 coflux 协议消息——CLI 保持零协议。中心 WS
// 成功升级后立即断开；loopback 只验证已持久 Origin 能拿到 101，不发送 browser 私钥或 grant。
const DOCTOR_TIMEOUT_MS = 5000;

function parseServerUrl(serverUrl) {
  const u = new URL(serverUrl);
  const useTls = u.protocol === "wss:";
  if (!useTls && u.protocol !== "ws:") throw new Error(`不支持的协议: ${u.protocol}（需 ws:// 或 wss://）`);
  const port = u.port ? Number(u.port) : (useTls ? 443 : 80);
  const path = u.pathname || "/";
  return { host: u.hostname, port, path, useTls };
}

async function timed(fn) {
  const t0 = Date.now();
  try { return { ok: true, ms: Date.now() - t0, ...(await fn()) }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) }; }
}

function probeDns(host) {
  return timed(async () => {
    const addrs = await dns.lookup(host, { all: true });
    return { detail: addrs.map((a) => a.address).join(", ") };
  });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port, timeout: DOCTOR_TIMEOUT_MS });
    const done = (ok, extra) => { socket.destroy(); resolve({ ok, ms: Date.now() - t0, ...extra }); };
    socket.once("connect", () => done(true, {}));
    socket.once("timeout", () => done(false, { error: `连接超时（>${DOCTOR_TIMEOUT_MS}ms）` }));
    socket.once("error", (e) => done(false, { error: e.message }));
  });
}

function probeTls(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = tls.connect({ host, port, servername: host, timeout: DOCTOR_TIMEOUT_MS }, () => {
      const detail = socket.authorized ? socket.getProtocol() : `${socket.getProtocol()}（证书未验证: ${socket.authorizationError}）`;
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - t0, detail });
    });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: `握手超时（>${DOCTOR_TIMEOUT_MS}ms）` }); });
    socket.once("error", (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.message }));
  });
}

// 手写一条最小 HTTP/1.1 Upgrade 请求，只看是否拿到 101——不建立真实 WebSocket 帧连接。
function probeWsUpgrade({ host, port, path, useTls, origin }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const key = crypto.randomBytes(16).toString("base64");
    const hostHeader = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
    const originHeader = origin ? `Origin: ${origin}\r\n` : "";
    const req = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n${originHeader}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - t0, ...r });
    };
    const onOpen = (socket) => {
      let buf = "";
      const timer = setTimeout(() => { socket.destroy(); finish({ ok: false, error: `升级响应超时（>${DOCTOR_TIMEOUT_MS}ms）` }); }, DOCTOR_TIMEOUT_MS);
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        const statusLine = buf.split("\r\n")[0];
        socket.destroy();
        const ok = /^HTTP\/1\.\d 101\b/.test(statusLine);
        finish(ok ? { ok, detail: statusLine } : { ok, error: `未收到 101 切换协议响应: ${statusLine}` });
      });
      socket.once("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
      socket.write(req);
    };
    const socket = useTls
      ? tls.connect({ host, port, servername: host, timeout: DOCTOR_TIMEOUT_MS })
      : net.connect({ host, port, timeout: DOCTOR_TIMEOUT_MS });
    socket.once(useTls ? "secureConnect" : "connect", () => onOpen(socket));
    socket.once("timeout", () => { socket.destroy(); finish({ ok: false, error: `连接超时（>${DOCTOR_TIMEOUT_MS}ms）` }); });
    socket.once("error", (e) => finish({ ok: false, error: e.message }));
  });
}

function printLayer(name, r) {
  const mark = r.ok ? "✓" : "✗";
  const msg = r.ok ? (r.detail ? `→ ${r.detail}` : "") : (r.error || "");
  console.log(`  ${mark} ${name} (${r.ms}ms)${msg ? `  ${msg}` : ""}`);
}

function printLocalLayer(name, r) {
  const mark = r.ok ? "✓" : "⚠";
  const msg = r.ok ? (r.detail ? `→ ${r.detail}` : "") : (r.error || "");
  const elapsed = Number.isFinite(r.ms) ? ` (${r.ms}ms)` : "";
  console.log(`  ${mark} ${name}${elapsed}${msg ? `  ${msg}` : ""}`);
}

// 本地事实汇总：服务进程存活、conn-state.json 连接态、凭证有无、FDA。返回连接态三态：
// "connected" | "not-connected"（有快照但非 connected，如 connecting/reconnecting）
// | "unknown"（服务未运行，或无快照——daemon 版本较旧还没写、或刚启动）。
// 三态区分是因为"无快照"不等于"未连接"：旧版 worker 不写 conn-state.json，把它当"未连接"
// 会把"连接态未知"误报成"认证/授权层有问题"（2026-07-23 实操验收发现）。
function printLocalFacts() {
  console.log("\n  Daemon 状态\n  ───────────");
  const registered = fs.existsSync(CRED);
  console.log(`  凭证:   ${registered ? "已登记" : "未登记"}`);
  const { running, active } = serviceRunningInfo();
  console.log(`  服务:   ${active}`);
  let connState = "unknown";
  if (running) {
    const conn = readConnState();
    if (conn?.state && CONN_STATE_LABEL[conn.state]) {
      console.log(`  中心:   ${CONN_STATE_LABEL[conn.state]}`);
      connState = conn.state === "connected" ? "connected" : "not-connected";
    } else {
      console.log("  中心:   (无连接态快照)");
    }
  } else {
    console.log("  中心:   未探测（服务未运行）");
  }
  if (IS_MAC) console.log(`  FDA:    ${fdaLabel(readFdaStatus())}`);
  console.log("");
  return { registered, running, connState };
}

function printConclusion(level, msg) {
  const mark = level === "ok" ? "✓" : level === "warning" ? "⚠" : "✗";
  console.log(`  ${mark} ${msg}\n`);
}

async function probeCenter(target) {
  const { host, port, useTls } = target;
  const dnsR = await probeDns(host);
  printLayer("DNS 解析", dnsR);
  if (!dnsR.ok) {
    return { ok: false, reason: "DNS 解析失败——检查网络连接/DNS 配置，或该域名是否可达。" };
  }

  const tcpR = await probeTcp(host, port);
  printLayer(`TCP 连接 (${host}:${port})`, tcpR);
  if (!tcpR.ok) {
    return { ok: false, reason: "DNS 可解析但 TCP 连不上——防火墙/代理拦截，或目标端口未开放。" };
  }

  if (useTls) {
    const tlsR = await probeTls(host, port);
    printLayer("TLS 握手", tlsR);
    if (!tlsR.ok) {
      return { ok: false, reason: "TCP 可连但 TLS 握手失败——可能是企业代理 MITM 证书、系统时间错误，或服务端证书问题。" };
    }
  }

  const wsR = await probeWsUpgrade(target);
  printLayer("WS 升级握手", wsR);
  if (!wsR.ok) {
    return { ok: false, reason: "网络层通但 WebSocket 升级被拒——可能是反代/负载均衡未正确转发 Upgrade 头，或路径不对。" };
  }
  return { ok: true };
}

async function probeLocalDirect() {
  const portResult = localGatewayPort();
  if (!portResult.ok) {
    printLocalLayer("Gateway bind", { ok: false, error: portResult.error });
    printLocalLayer("Loopback WS", { ok: false, error: "固定 gateway 端口未知，无法探测" });
    const grant = readLocalGatewaySummary();
    printLocalLayer("本地 grant", grant);
    return { ready: false };
  }

  const bind = await probeTcp("127.0.0.1", portResult.port);
  printLocalLayer(`Gateway bind (127.0.0.1:${portResult.port})`, bind);
  const grant = readLocalGatewaySummary();
  printLocalLayer("本地 grant", grant);

  let loopback;
  if (!bind.ok) {
    loopback = { ok: false, error: "gateway 未监听，跳过 WS 握手" };
  } else {
    loopback = await probeWsUpgrade({
      host: "127.0.0.1",
      port: portResult.port,
      path: "/device",
      useTls: false,
      // 没有持久 Origin 时仍发一个合法 Origin；403 能区分“coflux gateway 可达但未配对”。
      origin: grant.origin || "http://127.0.0.1",
    });
  }
  printLocalLayer("Loopback WS（主机侧）", loopback);
  return { ready: bind.ok && grant.ready && loopback.ok };
}

async function cmdDoctor() {
  const s = readSettings();
  const serverUrl = s.serverUrl || DEFAULT_SERVER;
  console.log(`\n  中心网络 —— ${serverUrl}\n  ────────────────────────────`);
  let center;
  try {
    center = await probeCenter(parseServerUrl(serverUrl));
  } catch (error) {
    printLayer("server URL", { ok: false, ms: 0, error: `${serverUrl}（${error.message}）` });
    center = { ok: false, reason: "中心地址配置无效。" };
  }

  console.log("\n  本地直连\n  ────────");
  const direct = await probeLocalDirect();
  const facts = printLocalFacts();
  const relayReady = center.ok && facts.running && facts.connState === "connected";

  if (direct.ready && relayReady) {
    printConclusion("ok", "本地直连与中心 relay 均可用。");
  } else if (!direct.ready && relayReady) {
    printConclusion("warning", "直连降级：中心 relay 仍可用，daemon 不是离线；检查上面的 gateway/grant/loopback 项。");
  } else if (direct.ready && !center.ok) {
    printConclusion("warning", "中心不可达，但本地直连可用；已加载且已配对页面可继续会话，刷新/冷启动不保证。");
  } else if (direct.ready) {
    printConclusion("warning", "本地直连可用；中心网络可达，但 daemon→中心连接未确认，relay 状态未知。");
  } else if (center.ok) {
    printConclusion("warning", "直连降级；中心网络可达，但 daemon→中心连接未确认。不要据此把 daemon 判为离线，查 `cofluxd logs`。");
  } else {
    printConclusion("error", `${center.reason || "中心不可达"} 同时本地直连降级；当前两条路径都未确认可用。`);
  }
}

function cmdLogs(v) {
  if (IS_MAC) {
    if (!fs.existsSync(LOG_FILE)) die(`暂无日志 ${LOG_FILE}`);
    run("tail", v.follow ? ["-f", LOG_FILE] : ["-n", "100", LOG_FILE], { stdio: "inherit" });
  } else if (IS_LINUX) {
    run("journalctl", ["--user", "-u", "coflux-daemon.service", ...(v.follow ? ["-f"] : ["-n", "100"])], { stdio: "inherit" });
  }
}

// 完全磁盘访问权限（FDA）引导：macOS 不允许程序自动弹出 FDA 授权窗（Apple 刻意设计），
// 上限就是检测 + 跳转系统设置 + 引导手动添加。授权对象是 supervisor 二进制本身——worker/PTY/agent
// 都是它的子进程，TCC 按 launchd 服务的 responsible process 归属，一次授权覆盖全树。
async function cmdFda() {
  if (!IS_MAC) die("此命令仅 macOS 可用（Linux 无 TCC/FDA 概念，无需授权）");
  console.log("\n  完全磁盘访问权限（FDA）引导\n  ──────────────────────────\n");
  console.log("  macOS 不支持程序自动弹出 FDA 授权窗，需手动在「系统设置」里添加。");
  console.log("  请把下面这个二进制拖进「隐私与安全性 → 完全磁盘访问权限」列表并勾选：\n");
  console.log(`    ${SUP_BIN}\n`);
  console.log("  即将打开系统设置面板，并在 Finder 中定位该二进制……\n");
  run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
  run("open", ["-R", SUP_BIN]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("  添加并勾选后按回车，重启服务使授权生效… ");
  } finally {
    rl.close();
  }
  restartService();
  console.log("\n✓ 已重启服务（FDA 对已运行进程不生效，必须重启才能生效）。稍候用 `cofluxd status` 确认已授予。");
}

function cmdUninstall(v) {
  stopService();
  try { fs.rmSync(IS_MAC ? PLIST : UNIT); } catch { /* */ }
  if (IS_LINUX) run("systemctl", ["--user", "daemon-reload"]);
  if (v.purge) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } console.log("✓ 已卸载并清除 " + HOME); }
  else console.log(`✓ 已卸载服务（保留二进制/配置/凭证于 ${HOME}；--purge 可全清）`);
}

/* ------------------------------ hook：agent 事件信使 ------------------------------ */
// agent hook 的上报信使：用户在 claude/codex 的 hook 配置里指向本命令，事件发生时它把
// 事件名转发给本机 worker 的固定 gateway（POST /hook），供活动状态判定。
//
// 输入两种形态都收：claude 与 codex hooks 引擎走 stdin JSON；codex 旧式 notify 把 payload
// 作为最后一个 argv 传入。只转发事件名 + notification 类型 + agent 会话 id + 本进程
// pid/ppid——payload 里的 prompt / 回答原文 / 通知正文一律不出机（隐私边界）。
//
// 契约（worker 侧将来实现 /hook 时依赖）：请求保持到收到响应才退出——worker 在处理期间
// 用上报的 pid 反查进程树归属哪个 session，本进程活着扫描才有效。
//
// 纪律：本命令绝不能干扰 agent 本体——任何失败（daemon 不在/端口不通/payload 畸形）都
// 静默退出 0（claude 把 Stop hook 的非零退出码解释为"阻止收尾"）；绝不写 stdout（claude
// 会把 hook 的 stdout 当决策 JSON 解析），调试信息走 stderr（COFLUX_HOOK_DEBUG=1 开启）。
const HOOK_STDIN_TIMEOUT_MS = 300; // stdin 没有数据时不能干等（notify 形态下 stdin 是继承的 TTY/空管道）
const HOOK_POST_TIMEOUT_MS = 2000;

const hookDebug = (...args) => { if (process.env.COFLUX_HOOK_DEBUG) console.error("[cofluxd hook]", ...args); };

async function readStdinJson() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const drained = (async () => { for await (const chunk of process.stdin) chunks.push(chunk); })().catch(() => {});
  await Promise.race([drained, sleep(HOOK_STDIN_TIMEOUT_MS)]);
  process.stdin.destroy(); // 超时后放掉 stdin，否则 for await 会吊着进程不退出
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function cmdHook() {
  try {
    const agent = positionals[1];
    if (agent !== "claude" && agent !== "codex") {
      hookDebug(`未知 agent: ${agent ?? "(缺参)"}（需 claude|codex）`);
      return;
    }
    let payload = null;
    if (positionals[2]) {
      try { payload = JSON.parse(positionals[2]); } catch { /* 非 JSON 的多余参数，忽略 */ }
    }
    if (!payload) payload = await readStdinJson();
    if (!payload || typeof payload !== "object") {
      hookDebug("无有效 payload，忽略");
      return;
    }
    // claude/codex hooks 引擎用 hook_event_name；codex notify 用 type
    const event = payload.hook_event_name || payload.type;
    if (typeof event !== "string" || !event) {
      hookDebug("payload 缺事件名，忽略");
      return;
    }
    const portResult = localGatewayPort();
    if (!portResult.ok) {
      hookDebug(portResult.error);
      return;
    }
    const notification = payload.notification_type ?? payload.notificationType;
    const body = {
      agent,
      event,
      pid: process.pid,
      ppid: process.ppid,
      // agent 自身的会话标识（claude: session_id / codex notify: thread-id），供 worker 去重与调试
      agentSessionId: payload.session_id ?? payload["thread-id"] ?? undefined,
      // Claude Notification 的类型枚举（permission_prompt / agent_needs_input …），不含正文
      notification: typeof notification === "string" && notification ? notification : undefined,
    };
    hookDebug("POST /hook", JSON.stringify(body));
    const res = await fetch(`http://127.0.0.1:${portResult.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOOK_POST_TIMEOUT_MS),
    });
    hookDebug(`响应 ${res.status}`);
  } catch (error) {
    hookDebug(error?.message || String(error));
  } finally {
    process.exit(0); // 无论成败都干净退出：不给 agent 留非零退出码，也不让残留句柄吊住进程
  }
}

/* --------------------- agent 协同控制（plan 074） --------------------- */
// 跑在 coflux 终端里的 claude/codex 用这组命令，把自己的工作外化成用户在 web/手机上
// **看得见、能接管**的 coflux 实体——而不是在自己的 Bash 里后台起一个谁也看不见的进程。
//
// 不需要任何凭证：daemon 用调用方 pid 反查进程树确认它属于哪个会话，树外一律拒。
// 与 `hook` 子命令的约定**相反**：这些命令必须写 stdout——输出就是给 agent 读的返回值。
// 也刻意不做自动重试：terminal new 有副作用，重试会开出两个终端，失败就把错误交给 agent。

const AGENT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_LINES = 200;

async function agentPost(body) {
  const portResult = localGatewayPort();
  if (!portResult.ok) die(portResult.error);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${portResult.port}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, pid: process.pid, ppid: process.ppid }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
  } catch (error) {
    die(`连不上本机 daemon：${error?.message || error}（daemon 没在跑？先看 cofluxd status）`);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON 响应按下面的兜底报错处理 */ }
  if (!res.ok || !parsed?.ok) die(parsed?.error || `daemon 返回 ${res.status}`);
  return parsed;
}

// 剥掉 ANSI/OSC 转义与 C0 控制字符，保留 \t 与 \n——snapshot 是给终端渲染的字节流，
// agent 要的是能读的纯文本。去转义放在 CLI 侧：daemon 的 snapshot 同时是 checkpoint 的
// 数据来源，不为 agent 的可读性改它的语义。
const ANSI_RE =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

function stripAnsi(raw) {
  return String(raw ?? "").replace(ANSI_RE, "");
}

/** 取最后 n 行并去掉尾部空行——VT snapshot 的下半屏通常是成片空行，对 agent 是纯噪音。 */
function tailLines(text, n) {
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-n).join("\n");
}

async function cmdTerminal(values) {
  const sub = positionals[1];
  if (sub === "new") {
    const command = values.cmd;
    if (!command) die(`terminal new 需要 --cmd "<命令>"`);
    const result = await agentPost({ action: "terminal.new", title: values.title || "", command });
    console.log(`已开终端 ${result.taskId}（用户可在 coflux 侧栏看到并随时接管）`);
    console.log(`看输出：cofluxd terminal read ${result.taskId}`);
  } else if (sub === "list") {
    const { terminals } = await agentPost({ action: "terminal.list" });
    if (!terminals.length) return void console.log("本工作区暂无终端");
    for (const t of terminals) {
      const exit = t.exitCode === undefined || t.exitCode === null ? "" : ` exit=${t.exitCode}`;
      console.log(`${t.taskId}  ${t.status}${exit}  ${t.title}`);
    }
  } else if (sub === "read") {
    const taskId = positionals[2];
    if (!taskId) die("terminal read 需要 <taskId>（用 cofluxd terminal list 查）");
    const requested = Number(values.lines);
    const lines = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_READ_LINES;
    const result = await agentPost({ action: "terminal.read", taskId });
    const exit = result.exitCode === undefined || result.exitCode === null ? "" : ` exit=${result.exitCode}`;
    console.log(`# ${result.status}${exit}`);
    const text = tailLines(stripAnsi(result.ansi), lines);
    console.log(text || "（暂无输出）");
  } else {
    die(`terminal 需要子命令：new | list | read`);
  }
}

async function cmdNotify() {
  const message = positionals.slice(1).join(" ").trim();
  if (!message) die(`notify 需要一句话，例如：cofluxd notify "两个方案拿不准，需要你定"`);
  await agentPost({ action: "notify", message });
  console.log("已通知用户（工作区在侧栏转为「等待交互」）");
}

async function cmdPorts() {
  const { ports } = await agentPost({ action: "ports" });
  if (!ports.length) return void console.log("本工作区暂无监听端口");
  for (const p of ports) console.log(`${p.port}  ${p.url}`);
}

const HELP = `cofluxd —— coflux daemon 管理

  cofluxd                 首次=up（打印浏览器授权链接），已配置=status
  cofluxd up [flags]      幂等：首次装+起，已装则按当前 settings.json 重装服务并重启
  cofluxd status          服务器/登记（含"等待授权"）/服务/连接状态
  cofluxd doctor          中心网络 + gateway bind/grant/loopback + daemon 状态分层自检
  cofluxd update          下载新二进制（不重启；supervisor 有变化时提示用 restart 应用）
  cofluxd restart         重启 daemon 应用新 supervisor（⚠ 结束本机所有活会话）
  cofluxd fda             [仅 macOS] 引导授予完全磁盘访问权限（避免 PTY 因 TCC 弹窗卡住）
  cofluxd logs [-f]       看 daemon 日志
  cofluxd down            停止
  cofluxd uninstall [--purge]   卸载（--purge 连二进制/配置/凭证一并删）
  cofluxd hook <claude|codex>   [agent hook 信使] 读 stdin/argv 的事件 JSON，转发给本机 daemon
                          （在 claude/codex 的 hook 配置里指向本命令；失败静默，不干扰 agent）

  以下几条供**跑在 coflux 终端里的 agent** 调用，把工作变成用户看得见、能接管的东西：

  cofluxd terminal new --cmd "<命令>" [--title "<标题>"]
                          开一个真实终端跑命令，用户在 coflux 侧栏能看到并随时接管
  cofluxd terminal list   列出本工作区的终端（含 status / 退出码）
  cofluxd terminal read <taskId> [--lines N]
                          读某个终端的内容（纯文本，默认最后 200 行；终端已退出也能读）
  cofluxd notify "<一句话>"  叫人：工作区在侧栏转为「等待交互」并显示这句话
  cofluxd ports           列出本工作区的监听端口及可直接打开的预览 URL

up flags: --server <ws://.../daemon>  --name <名>  --shell <路径>
通用: --version <vX|latest>(不传时 up 沿用已有二进制，update 默认 latest)  --bin-dir <dir>(用本地 cargo 产物)  --no-start
配置都在 ~/.coflux/settings.json（serverUrl/deviceName/shell），daemon 直接读；改后重跑 cofluxd up 生效。`;

// onboard/reload 已在命令面重梳中移除（用户拍板 2026-07-23，见 plans/035）：onboard 的交互
// 问答只剩"问设备名"，价值不足以撑一个命令；reload 与幂等化后的 up 语义重复。
const MIGRATED = {
  onboard: "onboard 已并入 up，直接运行 `cofluxd up`",
  reload: "reload 已并入 up（up 现幂等，会按 settings.json 重装服务并重启），直接运行 `cofluxd up`",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    name: { type: "string" },
    shell: { type: "string" },
    title: { type: "string" },
    cmd: { type: "string" },
    lines: { type: "string" },
    version: { type: "string" },
    "bin-dir": { type: "string" },
    "no-start": { type: "boolean", default: false },
    purge: { type: "boolean", default: false },
    follow: { type: "boolean", short: "f", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

let cmd = positionals[0];
if (values.help || cmd === "help") { console.log(HELP); process.exit(0); }
if (!cmd) cmd = fs.existsSync(SETTINGS) ? "status" : "up"; // 首次裸跑 → 引导

const handlers = { up: cmdUp, update: cmdUpdate, restart: cmdRestart, down: cmdDown, status: cmdStatus, doctor: cmdDoctor, fda: cmdFda, logs: cmdLogs, uninstall: cmdUninstall, hook: cmdHook, terminal: cmdTerminal, notify: cmdNotify, ports: cmdPorts };
const h = handlers[cmd];
if (!h) die(`未知命令: ${cmd}${MIGRATED[cmd] ? `\n${MIGRATED[cmd]}` : ""}\n\n${HELP}`);
await h(values);
