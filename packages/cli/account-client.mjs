// 账号客户端与桌面共用中心操作层；本文件不依赖 MCP 或 Node 常驻进程。
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

/* --------------------------------- 实体标识 -------------------------------- */
// `coflux:<kind>:<hex>`：设备 / 项目 / 工作区 / 终端 ID 的可粘贴短形式，hex 是 ID 的前几位
// （生成时固定取前 8 位）。解析大小写不敏感并归一成小写；凡是收 ID 的地方都收标识。
//
// 规则是纯拼接，故各端各自本地生成，不上协议：Rust 侧同一份规则在 crates/cli/src/handle.rs 与
// crates/worker/src/handle.rs——两版 CLI 的输出是逐字对齐的契约，改一边必须改另一边。
const HANDLE_KINDS = ["device", "project", "workspace", "terminal"];

/** `id` 的标识。空进空出：缺坐标时不能造出 `coflux:x:` 这样的半截标识。 */
export function entityHandle(kind, id) {
  const raw = typeof id === "string" ? id : "";
  return raw ? `coflux:${kind}:${raw.slice(0, 8).toLowerCase()}` : "";
}

/** 解析标识；不是标识（裸 UUID 也一样）返回 null，调用方按它看起来的那个 ID 处理。 */
export function parseHandle(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.toLowerCase().split(":");
  if (parts.length !== 3 || parts[0] !== "coflux") return null;
  const [, kind, hex] = parts;
  if (!HANDLE_KINDS.includes(kind) || !/^[0-9a-f]{4,32}$/.test(hex)) return null;
  return { kind, prefix: hex };
}

/**
 * `--device` / `--workspace` 筛选值命中某个 ID 吗？标识按类型 + 前缀比，其余按原样相等比。
 * 这是**比较**不是解析：不查表，只用同一套语法——也正因为如此，标识绝不能漏到字符串相等那条
 * 路上去，否则它谁也匹配不上，打印一个空列表还不报错。
 */
export function matchesTarget(target, id, kind) {
  const handle = parseHandle(target);
  if (!handle) return id === target;
  return handle.kind === kind && typeof id === "string" && id.toLowerCase().startsWith(handle.prefix);
}

/** 筛选参数拿到了别的类型的标识：说清楚，不要打印空列表。不是标识的一律放行（那就是个 ID）。 */
const HANDLE_LABELS = { device: "设备", project: "项目", workspace: "工作区", terminal: "终端" };
export function checkFilterHandle(flag, expected, target) {
  const handle = parseHandle(target);
  if (handle && handle.kind !== expected) {
    throw new Error(`--${flag} 需要${HANDLE_LABELS[expected]}标识或${HANDLE_LABELS[expected]} ID，给的是${HANDLE_LABELS[handle.kind]}标识 ${target}`);
  }
}

function origin(raw) {
  const url = new URL(raw.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
  if (url.username || url.password) throw new Error("服务器地址不能包含凭据");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("服务器必须使用 HTTPS（本机开发可用 HTTP）");
  return url.origin;
}
function unwrap(body) {
  if (body?.ok !== true) throw new Error(body?.error || "账号请求失败");
  return body.value;
}
async function request(server, path, token, body, timeout) {
  const response = await fetch(server + path, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return unwrap(await response.json());
}
function broker(home, body, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(home, "client.sock"));
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(new Error("账号请求超时，请查询操作结果")));
    socket.on("error", (error) => reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new Error("请先登录 Coflux 应用或运行 coflux login") : error));
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => { text += chunk; if (Buffer.byteLength(text) > 8 * 1024 * 1024) socket.destroy(new Error("响应过大")); });
    socket.on("end", () => { try { resolve(unwrap(JSON.parse(text))); } catch (error) { reject(error); } });
  });
}
/* ------------------------------ browser login ------------------------------ */
// `coflux login` with no credential flags (plan 20260923-oauth-login-redesign): RFC 8252 loopback
// redirect with PKCE (S256), or a paste code when the browser cannot reach back (SSH, or forced with
// COFLUX_LOGIN_PASTE=1). Same requests, same copy as the Rust CLI (crates/cli/src/browser_login.rs).

const LOGIN_FAILURES = { not_allowed: "该邮箱未开通 Coflux", not_verified: "该账号的邮箱未经验证，无法登录", cancelled: "已取消登录" };

function prefersPaste() {
  return ["COFLUX_LOGIN_PASTE", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"].some((name) => !!process.env[name]);
}

function openBrowser(url) {
  try {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* printing the URL is enough */
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function callbackPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} · Coflux</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{text-align:center;padding:24px}h1{font-size:18px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

function listenLoopback() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function browserLogin(server) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const listener = prefersPaste() ? null : await listenLoopback();
  const port = listener ? listener.address().port : undefined;
  let registered;
  try {
    registered = await request(server, "/api/client/login/request", null, {
      protocolVersion: 1, clientKind: "cli", host: (hostname() || "unknown-host").slice(0, 253),
      redirect: listener ? "loopback" : "paste", ...(listener ? { port } : {}),
      codeChallenge: challenge, codeChallengeMethod: "S256", state,
    }, 30000);
  } catch (error) {
    listener?.close();
    throw error;
  }
  const page = new URL(registered.url);
  // Only ever open a page on the server we are logging into.
  if (page.origin !== server) { listener?.close(); throw new Error("服务器返回的登录地址不在该服务器上"); }
  const exchange = (code) => request(server, "/api/client/login/exchange", null, { protocolVersion: 1, code, codeVerifier: verifier }, 30000);
  process.stderr.write(`在浏览器中打开以下地址完成登录（Ctrl-C 取消）：\n  ${page.href}\n`);
  if (!listener) {
    process.stderr.write("登录后页面会显示一次性登录码。\n");
    const code = await askLine("粘贴登录码：");
    if (!code) throw new Error("没有输入登录码");
    return exchange(code);
  }
  openBrowser(page.href);
  const waitMs = typeof registered.expiresAt === "number" && registered.expiresAt > Date.now() ? registered.expiresAt - Date.now() : 600000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("登录超时，请重新运行 coflux login")), waitMs);
    let done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listener.close();
      setTimeout(() => listener.closeAllConnections?.(), 1000).unref();
      if (error) reject(error); else resolve(value);
    }
    listener.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const answer = (status, title, body) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(callbackPage(title, body)); };
      if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) { answer(404, "页面不存在", "这个地址只用于 Coflux 登录回调。"); return; }
      const failed = url.searchParams.get("error");
      if (failed) {
        const message = LOGIN_FAILURES[failed] ?? "登录未完成，请重试";
        answer(200, "登录未完成", `${message}。可以关闭此页面，回到终端。`);
        finish(new Error(message));
        return;
      }
      exchange(url.searchParams.get("code") ?? "").then(
        (value) => { answer(200, "已登录", "已登录，可以回到终端。"); finish(null, value); },
        (error) => { answer(200, "登录未完成", "登录未完成，请回到终端查看原因。"); finish(error); },
      );
    });
  });
}

function saveSession(home, sessionPath, record) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const temp = `${sessionPath}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, sessionPath); }
  finally { fs.rmSync(temp, { force: true }); }
}

/** 写到底再继续：`device exec` 之后要用远端退出码退出，而 process.exit 会截断写向管道的输出。 */
function writeAll(stream, text) {
  if (!text) return Promise.resolve();
  return new Promise((resolve) => stream.write(text, resolve));
}
export function handlesAccountCommand(positionals, flags, home) {
  const [command, sub] = positionals;
  if (["login", "logout", "whoami", "device", "project"].includes(command)) return true;
  if (command === "workspace") return ["list", "new", "rename", "remove"].includes(sub);
  return ["terminal", "ports"].includes(command) && (flags.remote || flags.workspace || flags.device || (!process.env.COFLUX_TASK_ID && (fs.existsSync(join(home, "cli-session.json")) || fs.existsSync(join(home, "client.sock")))));
}
export async function runAccountCommand(positionals, flags, home) {
  const [command, sub = "list", id] = positionals;
  const sessionPath = join(home, "cli-session.json");
  const required = (key) => { if (!flags[key]) throw new Error(`缺少 --${key}`); return flags[key]; };
  const target = () => { if (!id) throw new Error("缺少目标 ID"); return id; };
  // `project import <path>`: the path is resolved on the **target device** (`~` expansion and
  // `git rev-parse --show-toplevel` both happen there), so the CLI only checks its shape — the same
  // rule as `device exec --cwd`. Expanding it here would resolve the caller's home on the wrong machine.
  const importPath = () => {
    const value = (id ?? "").trim();
    if (!value) throw new Error('缺少要导入的路径（导入当前目录写 coflux project import "$PWD"）');
    if (!(value.startsWith("/") || value === "~" || value.startsWith("~/"))) throw new Error('路径要绝对路径或 ~ 开头（它在目标设备上解析）；导入当前目录写 coflux project import "$PWD"');
    return value;
  };
  // `--device` falls back to the daemon-issued COFLUX_DEVICE_ID; empty on both sides is an error,
  // never a guess — silently importing onto the wrong machine is worse than failing.
  const deviceTarget = () => {
    const value = (flags.device || process.env.COFLUX_DEVICE_ID || "").trim();
    if (!value) throw new Error("缺少设备：请加 --device <id>（coflux device list 可以看到）");
    return value;
  };
  const print = (value) => console.log(JSON.stringify(value));
  if (command === "login") {
    const server = origin(flags.server || "https://api.coflux.dev");
    // No credential flags: sign in through the browser (loopback + PKCE, or a paste code over SSH).
    if (!flags.username && !flags["password-stdin"]) {
      const value = await browserLogin(server);
      if (!value?.token) throw new Error("服务器没有返回会话");
      saveSession(home, sessionPath, { server, token: value.token, accountId: value.accountId });
      console.log(`已登录为 ${value.login || "当前账号"}`);
      return;
    }
    const username = required("username");
    if (!flags["password-stdin"]) throw new Error("用 --password-stdin 从标准输入读取密码；密码不进入命令参数或配置文件");
    let password = "";
    for await (const chunk of process.stdin) { password += chunk; if (Buffer.byteLength(password) > 4096) throw new Error("密码过长"); if (password.includes("\n")) break; }
    const value = await request(server, "/api/client/login", null, { protocolVersion: 1, username, password: password.split("\n", 1)[0].replace(/\r$/, "") }, 30000);
    saveSession(home, sessionPath, { server, token: value.token, accountId: value.accountId });
    print({ accountId: value.accountId, server });
    return;
  }
  const session = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : null;
  const call = (operation) => {
    const body = { protocolVersion: 1, command: operation };
    // `terminal.wait` 与 `device.exec` 都可能在中心侧阻塞到 600 秒；其余账号操作 40 秒足够。
    const timeout = operation.op === "terminal.wait" || operation.op === "device.exec" ? 610000 : 40000;
    if (!session) {
      if (flags.server) throw new Error("请先登录指定服务器");
      return broker(home, body, timeout);
    }
    const server = origin(session.server);
    if (flags.server && origin(flags.server) !== server) throw new Error("目标服务器与登录记录不一致，请先登录目标服务器");
    if (!session.token) throw new Error("请先登录");
    return request(server, "/api/client/command", session.token, body, timeout);
  };
  if (command === "logout") {
    if (!session) throw new Error("此 CLI 未单独登录；应用账号请在 Coflux 中退出");
    await call({ op: "logout" });
    fs.rmSync(sessionPath);
    print({ loggedOut: true });
    return;
  }
  // `device exec`: one-shot cross-device execution, ssh semantics — not a Terminal, so the output is
  // not JSON either. stdout goes to stdout, stderr to stderr (always separate), the last line is
  // `# exit=<code>`, and the process exit code is the **remote** one. This CLI's own failures
  // (device offline, capability missing, bad cwd, timeout, bad arguments) all exit 255, so a caller's
  // shell test can tell "the remote command returned 1" from "it never ran".
  if (command === "device" && sub === "exec") {
    const fail = async (message) => { await writeAll(process.stderr, `✗ ${message}\n`); process.exit(255); };
    let value;
    try {
      if (!id) throw new Error("缺少设备 ID（coflux device list 可以看到）");
      const cmd = required("cmd");
      const timeout = Number(flags.timeout ?? 60);
      // 上限在这里就说清楚，别让中心的入参校验回一句「请求失败」。
      if (!Number.isInteger(timeout)) throw new Error("--timeout 必须是整数秒");
      if (timeout < 1 || timeout > 600) throw new Error("--timeout 取 1-600 秒；更久、或需要用户看见的长任务请改用 coflux terminal new");
      value = await call({ op: "device.exec", deviceId: id, command: cmd, cwd: flags.cwd ?? "", timeout });
    } catch (error) {
      await fail(error.message);
    }
    const exitCode = Number(value?.exitCode);
    if (!Number.isInteger(exitCode)) await fail("设备回执缺少退出码（中心版本过旧？）");
    await writeAll(process.stdout, String(value.stdout ?? ""));
    await writeAll(process.stderr, String(value.stderr ?? ""));
    await writeAll(process.stdout, `# exit=${exitCode}\n`);
    process.exit(exitCode);
  }
  let operation;
  if (command === "project") {
    if (sub === "import") operation = { op: "project.import", daemonId: deviceTarget(), path: importPath(), ...(flags.name ? { name: flags.name } : {}) };
  }
  if (command === "workspace") {
    if (sub === "new") operation = { op: "workspace.new", projectId: required("project"), branch: required("branch"), createNew: !flags["existing-branch"], ...(flags.name ? { name: flags.name } : {}) };
    if (sub === "rename") operation = { op: "workspace.rename", workspaceId: target(), name: required("name") };
    if (sub === "remove") operation = { op: "workspace.remove", workspaceId: target() };
  }
  if (command === "terminal") {
    // `--cmd` is "do script": typed into the new terminal once its shell is at the prompt; the terminal stays open.
    if (sub === "new") operation = { op: "terminal.new", workspaceId: required("workspace"), title: flags.title || "", command: flags.cmd || "" };
    if (sub === "run") operation = { op: "terminal.run", terminalId: target(), command: required("cmd") };
    if (sub === "read") operation = { op: "terminal.read", terminalId: target(), lines: Number(flags.lines ?? 200) };
    if (sub === "send") operation = { op: "terminal.send", terminalId: target(), text: required("text"), enter: !!flags.enter };
    if (sub === "wait") operation = { op: "terminal.wait", terminalId: target(), timeout: Number(flags.timeout ?? 30) };
    if (["stop", "remove"].includes(sub)) operation = { op: `terminal.${sub}`, terminalId: target() };
  }
  if (!operation && command !== "whoami" && command !== "ports" && sub !== "list") throw new Error("未知账号命令");
  // `project.import` is addressed by device like `snapshot`, so `--device` is an input to it rather than a filter.
  if (operation && ((flags.device && operation.op !== "project.import") || (flags.workspace && operation.op !== "terminal.new"))) throw new Error("目标 ID 已确定作用范围，请不要附加设备或工作区筛选参数");
  let value = await call(operation || { op: "snapshot" });
  if (command === "whoami") value = { accountId: value.accountId };
  else if (sub === "list" || command === "ports") {
    const field = { device: "devices", project: "projects", workspace: "workspaces", terminal: "terminals", ports: "ports" }[command];
    // 客户端字符串比较，不经中心解析：标识不在这里认，就会一个都匹配不上（空列表、还不报错）。
    if (flags.device) checkFilterHandle("device", "device", flags.device);
    if (flags.workspace) checkFilterHandle("workspace", "workspace", flags.workspace);
    value = value[field].filter((item) => (!flags.device || matchesTarget(flags.device, item.daemonId, "device")) && (!flags.workspace || matchesTarget(flags.workspace, item.workspaceId, "workspace") || (command === "workspace" && matchesTarget(flags.workspace, item.id, "workspace"))));
  }
  print(value);
}
