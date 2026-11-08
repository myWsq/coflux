#!/usr/bin/env node
// coflux：账号与本地、跨设备业务操作；不负责宿主生命周期。
import { entityHandle, handlesAccountCommand, runAccountCommand } from "./account-client.mjs";
import { error as printError, fail, info, success } from "./output.mjs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
// Native integration owns explicit workspace selection and conversation state. `secret` is native
// only too: it speaks the worker's kernel-attested socket and masks child output, and one
// implementation of that is enough (plan 20260926-agent-secret-input). `annotations` is native only
// as well: the worker keeps browser annotations and the Rust CLI renders them (plan
// 20260929-browser-annotations).
if (process.argv[2] === "agent" || process.argv[2] === "secret" || process.argv[2] === "annotations" || (process.argv[2] === "workspace" && process.argv[3] === "enter")) {
  const native = process.env.COFLUX_AGENT_BUNDLE
    ? join(process.env.COFLUX_AGENT_BUNDLE, "coflux")
    : join(HOME, "bin", "coflux");
  if (!existsSync(native)) {
    fail("This command is not available on this device.", "Update Coflux on this device with cofluxd update, then try again.");
  }
  const result = spawnSync(native, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) printError(result.error.message, "Update Coflux on this device with cofluxd update, then try again.");
  process.exit(result.status ?? 1);
}
const DEFAULT_LOCAL_GATEWAY_PORT = 8788;
/** Fallback next step for an error the daemon or the server relays without one. */
const HELP_NEXT = "Run coflux --help for usage.";
const die = (message, next = HELP_NEXT) => fail(message, next);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function localGatewayPort() {
  const raw = process.env.COFLUX_LOCAL_GATEWAY_PORT;
  if (raw === undefined || raw === "") return { ok: true, port: DEFAULT_LOCAL_GATEWAY_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `COFLUX_LOCAL_GATEWAY_PORT=${raw} is not a valid port` };
  }
  return { ok: true, port };
}

/* ---------------------- local transport (plan 20260926-agent-endpoint-hardening) ---------------------- */
// `/agent` and `/hook` reach the worker over its kernel-attested Unix socket first; the worker reads
// this process's pid from the kernel, so the body carries no pid/ppid there. The loopback TCP port
// is used only when the socket is **absent** (no file, or nobody listening: an older worker), and
// only then is COFLUX_LOCAL_GATEWAY_PORT read. A reply from the socket, refusals included, is final
// and never retried over TCP; a connect refused for any other reason (a sandbox's EPERM/EACCES)
// fails hard and names the socket. Mirrors `local_post` in crates/cli/src/gateway.rs.
// The path mirrors `SOCKET_FILE` in crates/runtime/src/agent_socket.rs.
const AGENT_SOCKET = join(HOME, "ipc", "agent.sock");
/** The worker never binds a longer socket path (sun_path limits), so a longer one is absent. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * One HTTP/1.1 POST over the agent socket.
 * → { ok: true, status, text } | { ok: false, kind: "absent" | "denied" | "transport", message }
 */
function socketPost(path, payload, timeoutMs) {
  if (Buffer.byteLength(AGENT_SOCKET) > MAX_SOCKET_PATH_BYTES) return Promise.resolve({ ok: false, kind: "absent" });
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = httpRequest(
      {
        socketPath: AGENT_SOCKET,
        path,
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => finish({ ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (error) => finish({ ok: false, kind: "transport", message: error?.message || String(error) }));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("request timed out"));
    }, timeoutMs);
    req.on("error", (error) => {
      if (!timedOut && error?.syscall === "connect") {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return finish({ ok: false, kind: "absent" });
        return finish({
          ok: false,
          kind: "denied",
          message: `This process is not allowed to reach the Coflux service at ${AGENT_SOCKET}: ${error.code || error.message}`,
          next: "If this runs in a sandbox, allow access to that socket.",
        });
      }
      finish({ ok: false, kind: "transport", message: error?.message || String(error) });
    });
    req.end(payload);
  });
}

/**
 * POST one JSON body to the local daemon: the agent socket first, the TCP gateway only when the
 * socket is absent. `body.pid`/`body.ppid` are transport business: dropped on the socket, set to
 * this process's on TCP.
 * → { ok: true, status, text } | { ok: false, kind: "refused" | "transport", message }
 */
async function localPost(path, body, timeoutMs) {
  const { pid: _pid, ppid: _ppid, ...rest } = body;
  const viaSocket = await socketPost(path, JSON.stringify(rest), timeoutMs);
  if (viaSocket.ok || viaSocket.kind === "transport") return viaSocket;
  if (viaSocket.kind === "denied") return { ok: false, kind: "refused", message: viaSocket.message, next: viaSocket.next };
  const portResult = localGatewayPort();
  if (!portResult.ok) return { ok: false, kind: "refused", message: portResult.error, next: "Unset COFLUX_LOCAL_GATEWAY_PORT, or set it to a port number." };
  try {
    const res = await fetch(`http://127.0.0.1:${portResult.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rest, pid: process.pid, ppid: process.ppid }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, status: res.status, text: await res.text() };
  } catch (error) {
    return { ok: false, kind: "transport", message: error?.message || String(error) };
  }
}
/* ------------------------------ hook：agent 事件信使 ------------------------------ */
// agent hook 的上报信使：用户在 claude/codex 的 hook 配置里指向本命令，事件发生时它把
// agent 自身的会话标识转发给本机 worker（POST /hook），供桌面端定位 transcript。Hooks carry no
// turn state: that comes from the agent's OSC 7501 reports.
//
// 输入两种形态都收：claude 与 codex hooks 引擎走 stdin JSON；codex 旧式 notify 把 payload
// 作为最后一个 argv 传入。只转发 agent 会话 id + 事件名 + 本进程 pid/ppid——payload 里的
// prompt / 回答原文 / 通知正文一律不出机（隐私边界）。A payload without a session id sends nothing.
//
// 契约：请求保持到收到响应才退出——worker 在处理期间用上报的 pid 反查进程树归属哪个
// session，本进程活着扫描才有效。
//
// 纪律：本命令绝不能干扰 agent 本体——任何失败（daemon 不在/端口不通/payload 畸形）都
// 静默退出 0（claude 把 Stop hook 的非零退出码解释为"阻止收尾"）；绝不写 stdout（claude
// 会把 hook 的 stdout 当决策 JSON 解析），调试信息走 stderr（COFLUX_HOOK_DEBUG=1 开启）。
const HOOK_STDIN_TIMEOUT_MS = 300; // stdin 没有数据时不能干等（notify 形态下 stdin 是继承的 TTY/空管道）
const HOOK_POST_TIMEOUT_MS = 2000;

const hookDebug = (...args) => { if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux hook]", ...args); };

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
      hookDebug(`unknown agent: ${agent ?? "(missing)"}; expected claude or codex`);
      return;
    }
    let payload = null;
    if (positionals[2]) {
      try { payload = JSON.parse(positionals[2]); } catch { /* 非 JSON 的多余参数，忽略 */ }
    }
    if (!payload) payload = await readStdinJson();
    if (!payload || typeof payload !== "object") {
      hookDebug("no valid payload; ignored");
      return;
    }
    // claude/codex hooks 引擎用 hook_event_name；codex notify 用 type
    const event = payload.hook_event_name || payload.type;
    if (typeof event !== "string" || !event) {
      hookDebug("payload has no event name; ignored");
      return;
    }
    // The agent's own session id (claude: session_id / codex notify: thread-id) is the only thing
    // the worker records from a hook; without one there is nothing to send.
    const agentSessionId = payload.session_id ?? payload["thread-id"];
    if (agentSessionId === undefined || agentSessionId === null) {
      hookDebug("payload has no session id; nothing to send");
      return;
    }
    const body = { agent, event, pid: process.pid, ppid: process.ppid, agentSessionId };
    hookDebug("POST /hook", JSON.stringify(body));
    // The agent socket first; the gateway port is resolved only when the socket is absent.
    const res = await localPost("/hook", body, HOOK_POST_TIMEOUT_MS);
    hookDebug(res.ok ? `answered ${res.status}` : res.message);
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
// Local read/send/run/wait/close/progress stay on the daemon. Notify, new/list/ports and ownership
// changes require a server acknowledgement. Scope follows cwd except terminal-owned
// notify/progress/ports, whose source remains the owning session.
// 与 `hook` 子命令的约定**相反**：这些命令必须写 stdout——输出就是给 agent 读的返回值。
// 也刻意不做自动重试：terminal new 有副作用，重试会开出两个终端，失败就把错误交给 agent。

const AGENT_TIMEOUT_MS = 30_000;
/** 调用方能收窄单次 `/agent` 等待的下限；再低就只够覆盖 node 自己的启动，等于必然超时。 */
const MIN_AGENT_TIMEOUT_MS = 200;
const DEFAULT_READ_LINES = 200;
// wait loops here because one agentPost round-trip is capped at 25 s on the loopback endpoint; each
// round the daemon blocks up to WAIT_ROUND_MS on its command-state watch and answers the moment the
// command finishes, so the loop never hammers it. Default 30 minutes overall.
const DEFAULT_WAIT_TIMEOUT_S = 1800;
const WAIT_ROUND_MS = 20_000;

// 每条请求都带调用方 cwd（plan 102）：agent 可以经 `/cd` 或 EnterWorktree 把活着的会话挪进同
// 设备的另一个 coflux 工作区，daemon 据此把本次请求的**目标**解析到 cwd 所在的工作区（会话的
// 归属工作区不变）。目录被删掉时 process.cwd() 会抛，按"报不出来"处理，daemon 退回归属工作区。
function callerCwd() {
  try { return process.cwd(); } catch { return ""; }
}

// 调用方可以用 COFLUX_AGENT_TIMEOUT_MS 收窄单次请求的等待上限（plan 104）。默认 30 秒是为
// agent 定的——它等得起；hook 脚本等不起：宿主按秒杀 hook（SessionStart 只给几秒），而经中心的
// 动作最坏要等 daemon 的 20 秒中心超时。被宿主杀在半路比拿不到答案坏得多（连坐标块都印不出来），
// 所以这类调用方自报一个更小的预算，到点干净失败、让脚本走回退。
// 只允许收窄不允许放宽：上限仍是 AGENT_TIMEOUT_MS，畸形值一律按默认处理。
function agentTimeoutMs() {
  const raw = Number(process.env.COFLUX_AGENT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return AGENT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(raw), MIN_AGENT_TIMEOUT_MS), AGENT_TIMEOUT_MS);
}

// The two kinds of `/agent` failure, separated for the executor's submit path: only a "transport"
// failure may be re-sent with the same submissionId (the daemon deduplicates on it); re-sending a
// "refused" request accomplishes nothing. Mirrors `AgentError` in crates/cli/src/gateway.rs.
async function agentPostResult(body) {
  const res = await localPost("/agent", { ...body, cwd: callerCwd() }, agentTimeoutMs());
  if (!res.ok) {
    if (res.kind === "refused") return res;
    return {
      ok: false,
      kind: "transport",
      message: `Cannot reach the Coflux service on this device: ${res.message}`,
      next: SERVICE_NEXT,
    };
  }
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { /* a non-JSON answer is reported below */ }
  const ok = res.status >= 200 && res.status < 300;
  if (!ok || !parsed?.ok) return { ok: false, kind: "refused", message: parsed?.error || `The Coflux service answered with HTTP ${res.status}.` };
  return { ok: true, value: parsed };
}

/** Next step when the local service cannot be reached at all. */
const SERVICE_NEXT = "Check that Coflux is running on this device: open Coflux.app, or run cofluxd status.";
/** Next step for a refusal about a terminal. */
const TERMINAL_NEXT = "Run coflux terminal list to check the terminal.";

/** `next` is shown under a refusal the daemon sent without one. */
async function agentPost(body, next = HELP_NEXT) {
  const result = await agentPostResult(body);
  if (!result.ok) die(result.message, result.next || next);
  return result.value;
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

/**
 * 一行终端的第一列：标识。daemon 已经在载荷里给了 `ref`；它没给（CLI 比 daemon 新）就按同一条
 * 规则从 `taskId` 现算一个——生成规则是纯拼接，两边算出来的东西一样。
 * 与 Rust 版 `row_handle`（crates/cli/src/commands.rs）逐字对齐。
 */
function rowHandle(t) {
  return (typeof t.ref === "string" && t.ref) || entityHandle("terminal", t.taskId);
}

/** ` busy` / ` idle` plus ` last=<code>` for a live, instrumented terminal; nothing otherwise. */
function commandSuffix(t) {
  if (!t.integrated) return "";
  const last = t.lastCommandExitCode === undefined || t.lastCommandExitCode === null ? "" : ` last=${t.lastCommandExitCode}`;
  return `${t.busy ? " busy" : " idle"}${last}`;
}

/** "do script": type a command into a terminal once its shell signalled prompt readiness. */
async function runCommand(taskId, command) {
  const result = await agentPost({ action: "terminal.run", taskId, command }, TERMINAL_NEXT);
  success(`Sent command #${result.commandSeq}`);
  info(`Wait for it with coflux terminal wait ${taskId}, and read its output with coflux terminal read ${taskId}.`);
}

/** A subcommand that needs a terminal id got none. */
function missingTaskId(sub, usage = "") {
  die("Missing terminal id.", `Run coflux terminal list to find it, then coflux terminal ${sub} <taskId>${usage}.`);
}

async function cmdTerminal(values) {
  const sub = positionals[1];
  if (sub === "new") {
    // Open first, then "do script": the terminal exists (and is reported) even when the command
    // cannot be typed — an old daemon refuses terminal.run as an unknown action and never runs
    // the command any other way. --cmd missing and --cmd= blank are the same: nothing is typed.
    const command = (values.cmd ?? "").trim() ? values.cmd : "";
    const result = await agentPost({ action: "terminal.new", title: values.title || "" });
    success(`Opened terminal ${result.taskId}`);
    if (command) {
      await runCommand(result.taskId, command);
    } else {
      info("It is a login shell the user can see and take over. It stays open until you close it.");
      info(`Run a command:   coflux terminal run ${result.taskId} --cmd="<command>"`);
      info(`Read its output: coflux terminal read ${result.taskId}`);
      info(`Close it:        coflux terminal close ${result.taskId}`);
    }
  } else if (sub === "run") {
    const taskId = positionals[2];
    if (!taskId) missingTaskId("run", ' --cmd="<command>"');
    const command = (values.cmd ?? "").trim() ? values.cmd : "";
    if (!command) die("Missing command.", `Pass it with --cmd: coflux terminal run ${taskId} --cmd="<command>".`);
    await runCommand(taskId, command);
  } else if (sub === "close") {
    const taskId = positionals[2];
    if (!taskId) missingTaskId("close");
    const result = await agentPost({ action: "terminal.close", taskId }, TERMINAL_NEXT);
    if (result.exited) {
      const exit = result.exitCode === undefined || result.exitCode === null ? "" : ` exit=${result.exitCode}`;
      success(`Closed terminal ${taskId}${exit}`);
    } else {
      info(`Closing terminal ${taskId}. Its shell is still exiting; check it with coflux terminal list.`);
    }
  } else if (sub === "list") {
    const { terminals } = await agentPost({ action: "terminal.list" });
    if (!terminals.length) return void info("No terminals in this workspace.");
    for (const t of terminals) {
      const exit = t.exitCode === undefined || t.exitCode === null ? "" : ` exit=${t.exitCode}`;
      console.log(`${rowHandle(t)}  ${t.status}${exit}${commandSuffix(t)}  ${t.title}`);
    }
  } else if (sub === "read") {
    const taskId = positionals[2];
    if (!taskId) missingTaskId("read");
    const requested = Number(values.lines);
    const lines = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_READ_LINES;
    const result = await agentPost({ action: "terminal.read", taskId }, TERMINAL_NEXT);
    const exit = result.exitCode === undefined || result.exitCode === null ? "" : ` exit=${result.exitCode}`;
    console.log(`# ${result.status}${exit}`);
    const text = tailLines(stripAnsi(result.ansi), lines);
    console.log(text || "(no output yet)");
  } else if (sub === "send") {
    const taskId = positionals[2];
    if (!taskId) missingTaskId("send", ' --text="<text>"');
    const text = values.text ?? "";
    if (!text && !values.enter) die("Nothing to send.", 'Pass --text="<text>", or --enter to send a single Enter.');
    await agentPost({ action: "terminal.send", taskId, text, enter: Boolean(values.enter) }, TERMINAL_NEXT);
    success(`Sent input to terminal ${taskId}`);
    info(`Check the result with coflux terminal read ${taskId}.`);
  } else if (sub === "wait") {
    const taskId = positionals[2];
    if (!taskId) missingTaskId("wait");
    const requested = Number(values.timeout);
    const timeoutSec = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WAIT_TIMEOUT_S;
    const seq = Number(values.seq);
    const commandSeq = Number.isInteger(seq) && seq > 0 ? seq : 0;
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      // Each round blocks inside the daemon (its command-state watch wakes it the moment the
      // command ends); a `running` answer only means the round elapsed.
      const roundMs = Math.min(WAIT_ROUND_MS, Math.max(1, deadline - Date.now()));
      const t = await agentPost({ action: "terminal.wait", taskId, commandSeq, timeoutMs: roundMs }, TERMINAL_NEXT);
      if (t.state !== "running") {
        const exit = t.exitCode === undefined || t.exitCode === null ? "" : ` exit=${t.exitCode}`;
        return void console.log(`# ${t.state === "exited" ? "exited" : "finished"}${exit}`);
      }
      if (Date.now() >= deadline) {
        die(
          `Timed out after ${timeoutSec}s: command #${t.commandSeq} in terminal ${taskId} is still running.`,
          `Wait longer with --timeout, or look at the screen with coflux terminal read ${taskId}.`,
        );
      }
    }
  } else {
    die(sub ? `Unknown terminal command: ${sub}.` : "Missing terminal command.", "Use one of: new, run, list, read, wait, send, close.");
  }
}

async function cmdNotify() {
  const message = positionals.slice(1).join(" ").trim();
  if (!message) die("Missing message.", 'Usage: coflux notify "<message>"');
  const result = await agentPost({ action: "notify", notificationId: randomUUID(), message });
  if (!result.notificationId) {
    die("The notification was not confirmed: this device's Coflux is too old to save it.", "Update Coflux on this device, then send it again.");
  }
  success("Notification sent");
}

async function cmdProgress() {
  const message = positionals.slice(1).join(" ").trim();
  if (!message) die("Missing message.", 'Usage: coflux progress "<message>"');
  await agentPost({ action: "progress", message });
  success("Progress updated");
}

// 「我在哪」与「跟着我搬」（plan 102 / 103）。三条都打一行 JSON，字段稳定——插件脚本按它比对，
// agent 也直接读。
//
//   coflux workspace                 只读：cwd 所在的有效工作区 + 本终端的归属工作区
//   coflux workspace locate [path]   把本终端的**归属**搬到 path 所属的工作区（未登记先登记）
//   coflux workspace forget <path>   该 worktree 已被删掉：其下终端搬回主工作区、记录消失
//
// locate/forget 是插件在 SessionStart / PostToolUse(EnterWorktree|ExitWorktree) / WorktreeRemove
// 上调的，同样零凭证（daemon 按进程树认身份）。daemon 旧到不认识这两个动作时它会回
// 「未知 action …」，agentPost 原样报错并非零退出——脚本据此静默放弃，不干扰会话。
async function cmdWorkspace() {
  const sub = positionals[1];
  if (!sub) {
    const result = await agentPost({ action: "workspace.current" });
    // ref / owningRef 原样透传：daemon 旧到不给就是 undefined，JSON.stringify 直接省掉这两个键
    // （与 Rust 版 render_workspace_current 同序同省略规则）。
    return void console.log(JSON.stringify({
      workspaceId: result.workspaceId,
      ref: result.ref,
      path: result.path,
      owningWorkspaceId: result.owningWorkspaceId,
      owningRef: result.owningRef,
      moved: Boolean(result.moved),
    }));
  }
  if (sub === "locate") {
    // 路径缺省取调用方 cwd；插件脚本一律显式传 hook 载荷里的 cwd（hook 在会话当前目录执行，
    // 与载荷里的 cwd 未必相同）。
    const path = positionals[2] || callerCwd();
    if (!path) die("Could not determine the current directory.", "Pass the path: coflux workspace locate <path>.");
    const result = await agentPost({ action: "workspace.locate", path });
    return void console.log(JSON.stringify({
      workspaceId: result.workspaceId,
      path: result.path,
      branch: result.branch,
      created: Boolean(result.created),
      moved: Boolean(result.moved),
    }));
  }
  if (sub === "forget") {
    const path = positionals[2];
    if (!path) die("Missing path.", "Usage: coflux workspace forget <path>");
    const result = await agentPost({ action: "workspace.forget", path });
    return void console.log(JSON.stringify({
      workspaceId: result.workspaceId,
      fallbackWorkspaceId: result.fallbackWorkspaceId,
      movedTerminals: result.movedTerminals ?? 0,
      removed: Boolean(result.removed),
    }));
  }
  die(`Unknown workspace command: ${sub}.`, "Use enter, locate or forget, or no subcommand to print the current workspace.");
}

async function cmdPorts() {
  const { ports } = await agentPost({ action: "ports" });
  if (!ports.length) return void info("No listening ports in this workspace.");
  for (const p of ports) console.log(`${p.port}  ${p.url}`);
}

/* -------------------------------- executor ------------------------------- */
// `coflux executor run`: hand one well-bounded sub-task to the built-in executor. Request bodies,
// stdout phrases and exit codes are aligned command-for-command with `run_executor` in
// crates/cli/src/commands.rs.
//
// Three phases: **submit** returns a runId (answered immediately, deduplicated by `submissionId`)
// -> the CLI **polls** status (a single `/agent` reply is capped at 25 seconds, so a long run can
// never hang off one request) -> the terminal state is rendered. On wait timeout a cancel goes out
// before the error: leaving an unwatched write job editing files is worse than the timeout itself.

// Tighter than WAIT_POLL_MS: the executor's terminal state is a return value someone is blocked on.
const EXECUTOR_POLL_MS = 2000;
const DEFAULT_EXECUTOR_TIMEOUT_S = 1800;
// How many times a submission may be re-sent after a *transport* failure. The retry reuses the same
// submissionId and the daemon deduplicates on it — "never blindly resubmit" forbids a second id,
// not a second attempt.
const EXECUTOR_SUBMIT_RETRIES = 2;

/** This process's stable submission id: pid plus the nanosecond it was minted. Generated once. */
function submissionId() {
  const nanos = BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n);
  return `sub-${process.pid}-${nanos}`;
}

function executorTimeoutSecs(raw) {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_EXECUTOR_TIMEOUT_S;
}

function executorChangedFiles(status) {
  return Array.isArray(status?.changedFiles) ? status.changedFiles.filter((f) => typeof f === "string") : [];
}

/** stdout for a success: a machine-readable status line, the final reply, then the changed files. */
function renderExecutorSuccess(status) {
  const out = ["# succeeded"];
  const summary = String(status?.summary ?? "").trim();
  out.push(summary || "(the executor left no final reply)");
  const files = executorChangedFiles(status);
  if (!files.length) out.push("Changed files: none");
  else { out.push(`Changed files (${files.length}):`); out.push(...files); }
  out.push("The executor never commits. Review the changes and commit them yourself.");
  return out.join("\n");
}

/** The error for a non-success terminal state: state, reason, and what already changed. */
function renderExecutorFailure(status) {
  const terminal = String(status?.terminal ?? "") || "unknown";
  const reason = String(status?.error ?? "").trim() || String(status?.note ?? "").trim() || "no reason given";
  const files = executorChangedFiles(status);
  // A reason that already ends a sentence (the executor's incomplete-list note does) takes no second
  // period.
  const stop = /[.!?]$/.test(reason) ? "" : ".";
  const tail = files.length ? `${stop} Files already changed (${files.length}): ${files.join(" ")}` : "";
  return {
    message: `Executor run ended as ${terminal}: ${reason}${tail}`,
    next: executorNextStep(terminal, files.length > 0),
  };
}

/** The next step for a run that ended as `terminal`, depending on whether it left changed files
 * behind. A rejected run never started, a cancelled one was stopped on purpose, and an `unknown` one
 * lost its host, so its file list may be short. The Rust CLI prints the same strings. */
function executorNextStep(terminal, leftFiles) {
  switch (terminal) {
    case "rejected":
      return "Nothing ran. Send this run again once the reason above is resolved.";
    case "model_error":
      return leftFiles
        ? "Review the changes it left, then send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead."
        : "Send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead.";
    case "tool_failed":
      return leftFiles
        ? "Review the changes it left, then send the run again. If it fails the same way, tell the user."
        : "Send the run again. If it fails the same way, tell the user.";
    case "cancelled":
      return leftFiles
        ? "It was stopped before it finished, by the user, a timeout or its host going away. Review the changes it left and find out why before sending it again."
        : "It was stopped before it finished, by the user, a timeout or its host going away. Find out why before sending it again.";
    default:
      return "Its host went away mid-run, so the list of changed files may be incomplete. Check the workspace before sending it again.";
  }
}

function renderExecutorTimeout(timeoutSec, runId, phase) {
  return {
    message: `Timed out after ${timeoutSec}s: executor run ${runId} was still ${phase} and has been cancelled.`,
    next: "Send it again with a larger --timeout.",
  };
}

/** Submit. A transport failure retries with the same submissionId; a refusal is reported verbatim.
 * `title` names the run on the desktop's card (plan 20260929-executor-pip); empty = the daemon
 * falls back to the prompt's first line. */
async function executorSubmit(prompt, write, title) {
  const submission = submissionId();
  for (let attempt = 0; ; attempt += 1) {
    const result = await agentPostResult({ action: "executor.submit", submissionId: submission, prompt, write, title });
    if (result.ok) {
      const runId = String(result.value?.runId ?? "");
      if (!runId) die("The Coflux service did not return a run id.", "Update Coflux on this device, then try again.");
      return runId;
    }
    if (result.kind === "refused" || attempt >= EXECUTOR_SUBMIT_RETRIES) die(result.message, result.next || HELP_NEXT);
    await sleep(EXECUTOR_POLL_MS);
  }
}

async function cmdExecutor(values) {
  if (positionals[1] !== "run") die("Unknown executor command.", 'Usage: coflux executor run --prompt="<task>" [--title="<title>"] [--write]');
  const prompt = String(values.prompt ?? "").trim();
  if (!prompt) {
    die("Missing prompt.", 'Describe the task with --prompt, for example --prompt="Fix the clippy warnings in crates/worker".');
  }
  const write = Boolean(values.write);
  const title = String(values.title ?? "").trim();
  const timeoutSec = executorTimeoutSecs(values.timeout);
  const deadline = Date.now() + timeoutSec * 1000;
  const runId = await executorSubmit(prompt, write, title);
  for (;;) {
    // The first poll does not sleep: a rejection (write lock taken, model not configured) has to
    // surface immediately instead of costing the caller a whole poll interval.
    const status = await agentPost({ action: "executor.status", runId });
    if (status.phase === "done") {
      // `succeeded` is about the *task*; the envelope's top-level `ok` only says the request itself
      // was accepted.
      if (status.succeeded) return void console.log(renderExecutorSuccess(status));
      const failure = renderExecutorFailure(status);
      die(failure.message, failure.next);
    }
    if (Date.now() >= deadline) {
      // Cancel before reporting: an unwatched write job still editing files in the background is
      // far worse than the timeout itself.
      await agentPostResult({ action: "executor.cancel", runId });
      const timeout = renderExecutorTimeout(timeoutSec, runId, status.phase);
      die(timeout.message, timeout.next);
    }
    await sleep(EXECUTOR_POLL_MS);
  }
}

const HELP = `Work with Coflux terminals, workspaces and your account.

Usage:
  coflux <command> [subcommand] [flags]

Commands for agents running in a Coflux terminal:
  coflux terminal new [--title=<title>] [--cmd=<command>]
      Open a terminal: a login shell on a real tty in the workspace directory. The user sees
      it in the sidebar and can take it over. It stays open until you close it. With --cmd,
      the command is typed in once the prompt is ready, the same as new followed by run.
  coflux terminal run <taskId> --cmd=<command>
      Type a command into the terminal once its prompt is ready. Refused while the previous
      command is still running.
  coflux terminal wait <taskId> [--timeout=<seconds>] [--seq=<N>]
      Wait for the current (or Nth) command to finish and print "# finished exit=<code>",
      or "# exited exit=<code>" when the shell itself ended. Default timeout: 30 minutes.
  coflux terminal read <taskId> [--lines=<N>]
      Print the end of the terminal's scrollback as plain text. Default: the last 200 lines.
  coflux terminal send <taskId> --text=<text> [--enter]
      Type text into the terminal; --enter adds Enter. Refused while the user has taken over.
  coflux terminal list
      List this workspace's terminals with their status and exit code. Live ones also show
      busy or idle and the exit code of their last command.
  coflux terminal close <taskId>
      End the terminal.
  coflux notify "<message>"
      Send the user a notification. Confirmed once the server has saved it.
  coflux progress "<message>"
      Show a progress line on the workspace card. The next one replaces it.
  coflux ports
      List this workspace's listening ports and their preview URLs.
  coflux secret ask NAME --reason "<why>" [--timeout <seconds>]
  coflux secret exec NAME [NAME…] -- <cmd> [args…]
  coflux secret inject NAME --file <path> [--key KEY]
      Get a secret (API key, password) from the user on their Coflux desktop without the
      value entering your context: ask prints only provided | declined | cancelled; exec
      runs a command with the value in a same-name environment variable and shows it as ***
      in the output; inject writes KEY=value into a dotenv file in this workspace.
      Details: coflux secret help
  coflux annotations list [--json]
  coflux annotations watch [--timeout <seconds>] [--json]
  coflux annotations resolve <id> --note "<what you changed>"
      Browser annotations: elements the user marked in Coflux's built-in browser for this
      workspace, with their comment, component names and source location when known,
      selector, and screenshot/reference image paths. list prints the pending ones as
      markdown; watch blocks until there are some (default 30 minutes); after implementing
      one, resolve it with a note the user reads to review the change.
  coflux executor run --prompt=<task> [--title=<title>] [--write] [--timeout <seconds>]
      Hand a well-bounded sub-task to the built-in executor and wait for its final reply and
      the files it changed. Each run is one-shot. Read-only unless --write, with one writing
      run per workspace at a time. It has no network and never commits. --title names the
      progress card the user sees on this terminal. Needs Coflux.app on this machine.
  coflux workspace
      Print one JSON line: workspaceId (where your local commands land), path,
      owningWorkspaceId (the workspace this terminal belongs to) and moved.
  coflux workspace enter <path>
      Enter a workspace of the same repository and move this terminal there. Use the
      returned path explicitly in later tool calls.
  coflux workspace locate [path]
      Move this terminal to the workspace that owns path (default: the current directory),
      registering a worktree of the same repository when needed. The plugin calls this.
  coflux workspace forget <path>
      The worktree at path was deleted: move its terminals back to the main workspace and
      drop its record. Does not run git worktree remove.
  coflux hook <claude|codex>
      Forward an agent hook event from stdin or argv to this device. Never fails the agent.

Account commands (JSON output):
  coflux login [--server <url>]
      Sign in through the browser. Over SSH, or with COFLUX_LOGIN_PASTE=1, paste a code.
  coflux login --username <name> --password-stdin [--server <url>]
  coflux whoami | logout
  coflux device list | project list | workspace list
  coflux device exec <deviceId> --cmd=<command> [--cwd=<dir>] [--timeout=<seconds>]
      Run one command on another device, like ssh host "cmd": it runs under sh -c, stdout
      and stderr come back separately, the last line is "# exit=<code>", and the exit code
      is the remote one (255 when this command itself fails). Not a terminal: no PTY,
      nothing in the sidebar, no stdin. --cwd defaults to the device user's home and must be
      absolute or start with ~. --timeout defaults to 60 seconds, at most 600. For
      passwords, TUIs or long work the user should see, use coflux terminal new.
  coflux project import <path> [--device <id>] [--name <name>]
      Turn a git repository on a device into a project with its main workspace and print
      one JSON line: projectId, name, repoPath, defaultBranch, workspaceId, path,
      alreadyImported. <path> is resolved on the device and must be absolute or start with
      ~; to import the current directory, pass "$PWD". --device defaults to
      COFLUX_DEVICE_ID. Importing the same repository again returns the existing project
      with alreadyImported=true.
  coflux workspace new --project <id> --branch <branch> [--existing-branch]
  coflux workspace rename <id> --name <name> | workspace remove <id>
  coflux terminal new --workspace <id> [--cmd <command>] [--title <title>]
  coflux terminal list [--device <id>] [--workspace <id>]
  coflux terminal run|read|wait|send|stop|remove <id> --remote
  coflux ports --remote
      When the Coflux app is signed in, these use its account; otherwise run coflux login.

Ids and handles:
  Wherever an id is accepted you can pass a handle, coflux:<kind>:<first 8 of id>, for
  example coflux:workspace:3f2a1b7c (case-insensitive). Results carry it as ref. A prefix
  that matches several entities asks for the full id; a handle of the wrong kind is an error.

Flags:
  -h, --help    Show this help

Environment:
  COFLUX_AGENT_TIMEOUT_MS    Lower the wait for one local request (default 30000), for hook
                             scripts with a hard time limit
  NO_COLOR                   Turn off colour

To manage this device, use Coflux.app or cofluxd.`;
/** parseArgs errors in the same words as the Rust CLI (crates/cli/src/args.rs). */
function argumentError(error) {
  const message = String(error?.message ?? error);
  const first = message.split(". ")[0];
  const missing = /^Option '(.+)' argument missing/.exec(first);
  if (missing) return `Option '${missing[1]}' needs a value`;
  const unexpected = /^Option '(.+)' does not take an argument/.exec(first);
  if (unexpected) return `Option '${unexpected[1]}' does not take a value`;
  return first;
}

let parsedArgs;
try {
  parsedArgs = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: "string" },
    workspace: { type: "string" },
    device: { type: "string" },
    project: { type: "string" },
    branch: { type: "string" },
    remote: { type: "boolean" },
    json: { type: "boolean" },
    "password-stdin": { type: "boolean" },
    "existing-branch": { type: "boolean" },
    server: { type: "string" },
    name: { type: "string" },
    title: { type: "string" },
    cmd: { type: "string" },
    lines: { type: "string" },
    timeout: { type: "string" },
    seq: { type: "string" },
    // `device exec`: the working directory on the remote device (absolute, or a `~` prefix).
    cwd: { type: "string" },
    text: { type: "string" },
    // executor: the only free-form input is the prompt; the model is configured once in Coflux.app.
    prompt: { type: "string" },
    // executor: read-only by default; --write is the only mode switch.
    write: { type: "boolean", default: false },
    enter: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  });
} catch (error) {
  die(argumentError(error));
}
const { values, positionals } = parsedArgs;

const cmd = positionals[0];
if (values.help || cmd === "help" || !cmd) { console.log(HELP); process.exit(0); }
if (handlesAccountCommand(positionals, values, HOME)) {
  try { await runAccountCommand(positionals, values, HOME); } catch (error) { die(error.message, error.next); }
  process.exit(0);
}
const handlers = { hook: cmdHook, terminal: cmdTerminal, notify: cmdNotify, progress: cmdProgress, ports: cmdPorts, executor: cmdExecutor, workspace: cmdWorkspace };
const handler = handlers[cmd];
if (!handler) die(`Unknown command: ${cmd}`, "Run coflux --help to see the commands. To manage this device, use Coflux.app or cofluxd.");
await handler(values);
