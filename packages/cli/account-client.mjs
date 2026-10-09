// 账号客户端与桌面共用中心操作层；本文件不依赖 MCP 或 Node 常驻进程。
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { error as printError, success } from "./output.mjs";

/** An error with the next step to show under it. */
function cliError(message, next) {
  const error = new Error(message);
  if (next) error.next = next;
  return error;
}
const USAGE_NEXT = "Run coflux --help for usage.";
const LOGIN_NEXT = "Sign in to the Coflux app, or run coflux login.";
// The public server. Sessions saved before it moved to its ICP-registered name name the old origin.
const DEFAULT_ACCOUNT_SERVER = "https://api.coflux.yourantiandi.com";
const LEGACY_ACCOUNT_SERVER = "https://api.coflux.dev";

/* --------------------------------- 实体标识 -------------------------------- */
// `coflux:<kind>:<hex>`：设备 / 项目 / 工作区 / 终端 ID 的可粘贴短形式，hex 是 ID 的前几位
// （生成时固定取前 8 位）。解析大小写不敏感并归一成小写；凡是收 ID 的地方都收标识。
//
// 规则是纯拼接，故各端各自本地生成，不上协议：Rust 侧同一份规则在 crates/cli/src/handle.rs 与
// crates/runtime/src/handle.rs——两版 CLI 的输出是逐字对齐的契约，改一边必须改另一边。
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
export function checkFilterHandle(flag, expected, target) {
  const handle = parseHandle(target);
  if (handle && handle.kind !== expected) {
    throw cliError(
      `--${flag} needs a ${expected} id or handle, but ${target} is a ${handle.kind} handle.`,
      `Run coflux ${expected === "workspace" ? "workspace" : "device"} list to find the ${expected} id.`,
    );
  }
}

function origin(raw) {
  const url = new URL(raw.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
  if (url.username || url.password) throw cliError("The server URL must not contain credentials.", "Pass it as --server https://<host>.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw cliError("The server URL must use HTTPS.", "Use https://, or http://localhost for local development.");
  }
  return url.origin;
}
function unwrap(body) {
  if (body?.ok !== true) throw new Error(body?.error || "The account request failed.");
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
    socket.setTimeout(timeout, () => socket.destroy(cliError("The account request timed out.", "Check whether it took effect before you try again.")));
    socket.on("error", (error) => reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? cliError("You are not signed in.", LOGIN_NEXT) : error));
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => { text += chunk; if (Buffer.byteLength(text) > 8 * 1024 * 1024) socket.destroy(new Error("The response was too large.")); });
    socket.on("end", () => { try { resolve(unwrap(JSON.parse(text))); } catch (error) { reject(error); } });
  });
}
/* ------------------------------ browser login ------------------------------ */
// `coflux login` with no credential flags (plan 20260923-oauth-login-redesign): RFC 8252 loopback
// redirect with PKCE (S256), or a paste code when the browser cannot reach back (SSH, or forced with
// COFLUX_LOGIN_PASTE=1). Same requests, same copy as the Rust CLI (crates/cli/src/browser_login.rs).

const LOGIN_FAILURES = {
  not_allowed: "This email address has no Coflux access.",
  not_verified: "This account's email address is not verified.",
  cancelled: "Sign-in was cancelled.",
};

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} - Coflux</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{text-align:center;padding:24px}h1{font-size:18px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
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
  if (page.origin !== server) { listener?.close(); throw cliError("The server returned a sign-in page on another host.", "Check the --server URL, then run coflux login again."); }
  const exchange = (code) => request(server, "/api/client/login/exchange", null, { protocolVersion: 1, code, codeVerifier: verifier }, 30000);
  process.stderr.write(`To sign in, open this page in your browser:\n\n    ${page.href}\n\nPress Ctrl-C to cancel.\n`);
  if (!listener) {
    process.stderr.write("After you sign in, the page shows a one-time code.\n");
    const code = await askLine("Paste the code: ");
    if (!code) throw cliError("No code entered.", "Run coflux login again.");
    return exchange(code);
  }
  openBrowser(page.href);
  const waitMs = typeof registered.expiresAt === "number" && registered.expiresAt > Date.now() ? registered.expiresAt - Date.now() : 600000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(cliError("Sign-in timed out.", "Run coflux login again.")), waitMs);
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
      if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) { answer(404, "Not found", "This address only serves the Coflux sign-in callback."); return; }
      const failed = url.searchParams.get("error");
      if (failed) {
        const message = LOGIN_FAILURES[failed] ?? "Sign-in did not complete.";
        answer(200, "Sign-in not completed", `${message} You can close this page and return to the terminal.`);
        finish(cliError(message, "Run coflux login again."));
        return;
      }
      exchange(url.searchParams.get("code") ?? "").then(
        (value) => { answer(200, "Signed in", "You are signed in. You can return to the terminal."); finish(null, value); },
        (error) => { answer(200, "Sign-in not completed", "Sign-in did not complete. See the terminal for the reason."); finish(error); },
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
  const required = (key) => { if (!flags[key]) throw cliError(`Missing --${key}.`, USAGE_NEXT); return flags[key]; };
  const target = () => { if (!id) throw cliError("Missing id.", USAGE_NEXT); return id; };
  // `project import <path>`: the path is resolved on the **target device** (`~` expansion and
  // `git rev-parse --show-toplevel` both happen there), so the CLI only checks its shape — the same
  // rule as `device exec --cwd`. Expanding it here would resolve the caller's home on the wrong machine.
  const importPath = () => {
    const value = (id ?? "").trim();
    if (!value) throw cliError("Missing path.", 'To import the current directory, run coflux project import "$PWD".');
    if (!(value.startsWith("/") || value === "~" || value.startsWith("~/"))) {
      throw cliError("The path must be absolute or start with ~, because it is resolved on the device.", 'To import the current directory, run coflux project import "$PWD".');
    }
    return value;
  };
  // `--device` falls back to the daemon-issued COFLUX_DEVICE_ID; empty on both sides is an error,
  // never a guess — silently importing onto the wrong machine is worse than failing.
  const deviceTarget = () => {
    const value = (flags.device || process.env.COFLUX_DEVICE_ID || "").trim();
    if (!value) throw cliError("Missing device.", "Pass --device <id>. Run coflux device list to see your devices.");
    return value;
  };
  const print = (value) => console.log(JSON.stringify(value));
  if (command === "login") {
    const server = origin(flags.server || DEFAULT_ACCOUNT_SERVER);
    // No credential flags: sign in through the browser (loopback + PKCE, or a paste code over SSH).
    if (!flags.username && !flags["password-stdin"]) {
      const value = await browserLogin(server);
      if (!value?.token) throw cliError("The server did not return a session.", "Run coflux login again.");
      saveSession(home, sessionPath, { server, token: value.token, accountId: value.accountId });
      success(value.login ? `Signed in as ${value.login}` : "Signed in");
      return;
    }
    const username = required("username");
    if (!flags["password-stdin"]) throw cliError("Missing --password-stdin.", "Pipe the password on stdin and pass --password-stdin.");
    let password = "";
    for await (const chunk of process.stdin) { password += chunk; if (Buffer.byteLength(password) > 4096) throw cliError("The password is too long.", "Check what is piped to stdin."); if (password.includes("\n")) break; }
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
      if (flags.server) throw cliError("You are not signed in to that server.", "Run coflux login --server <url> first.");
      return broker(home, body, timeout);
    }
    const server = origin(session.server === LEGACY_ACCOUNT_SERVER ? DEFAULT_ACCOUNT_SERVER : session.server);
    if (flags.server && origin(flags.server) !== server) throw cliError("You are signed in to a different server.", "Run coflux login --server <url> first.");
    if (!session.token) throw cliError("You are not signed in.", "Run coflux login.");
    return request(server, "/api/client/command", session.token, body, timeout);
  };
  if (command === "logout") {
    if (!session) throw cliError("This CLI is not signed in on its own.", "To sign out of the app account, sign out in Coflux.");
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
    const fail = (message, next = USAGE_NEXT) => { printError(message, next); process.exit(255); };
    let value;
    try {
      if (!id) throw cliError("Missing device id.", "Run coflux device list to see your devices.");
      const cmd = required("cmd");
      const timeout = Number(flags.timeout ?? 60);
      // State the limits here rather than let the server's validation answer with a bare failure.
      if (!Number.isInteger(timeout)) throw cliError("--timeout must be a whole number of seconds.", "Use a value from 1 to 600.");
      if (timeout < 1 || timeout > 600) {
        throw cliError("--timeout must be between 1 and 600 seconds.", "For longer work the user should see, open a terminal with coflux terminal new.");
      }
      value = await call({ op: "device.exec", deviceId: id, command: cmd, cwd: flags.cwd ?? "", timeout });
    } catch (error) {
      fail(error.message, error.next);
    }
    const exitCode = Number(value?.exitCode);
    if (!Number.isInteger(exitCode)) fail("The device did not report an exit code.", "The server may need an update; try again later.");
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
  if (!operation && command !== "whoami" && command !== "ports" && sub !== "list") throw cliError(`Unknown command: ${positionals.join(" ")}`, "Run coflux --help to see the commands.");
  // `project.import` is addressed by device like `snapshot`, so `--device` is an input to it rather than a filter.
  if (operation && ((flags.device && operation.op !== "project.import") || (flags.workspace && operation.op !== "terminal.new"))) {
    throw cliError("--device and --workspace cannot be combined with an id.", "Drop the filter; the id already names the target.");
  }
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
