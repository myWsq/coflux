#!/usr/bin/env node
// coflux：账号与本地、跨设备业务操作；不负责宿主生命周期。
import { handlesAccountCommand, runAccountCommand } from "./account-client.mjs";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const HOME = process.env.COFLUX_HOME || join(homedir(), ".coflux");
// Native integration owns explicit workspace selection and conversation state.
if (process.argv[2] === "agent" || (process.argv[2] === "workspace" && process.argv[3] === "enter")) {
  const native = process.env.COFLUX_AGENT_BUNDLE
    ? join(process.env.COFLUX_AGENT_BUNDLE, "coflux")
    : join(HOME, "bin", "coflux");
  if (!existsSync(native)) {
    console.error("Coflux integration is unavailable. Update this device with cofluxd update.");
    process.exit(1);
  }
  const result = spawnSync(native, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const DEFAULT_LOCAL_GATEWAY_PORT = 8788;
const die = (message) => { console.error("✗ " + message); process.exit(1); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function localGatewayPort() {
  const raw = process.env.COFLUX_LOCAL_GATEWAY_PORT;
  if (raw === undefined || raw === "") return { ok: true, port: DEFAULT_LOCAL_GATEWAY_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `COFLUX_LOCAL_GATEWAY_PORT=${raw} 无法定位固定监听端口` };
  }
  return { ok: true, port };
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
      // Stop/SubagentStop 独有：本会话在飞的后台工作（shell/subagent/monitor/workflow）。claude
      // 官方设它就是为了让 hook 区分「真做完了」与「挂起等后台把自己叫醒」。只传条数——条目里的
      // description 是自由文本（含路径与代码片段），按本命令的隐私边界不出机。
      backgroundTasks: Array.isArray(payload.background_tasks) ? payload.background_tasks.length : undefined,
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
// local-first（plan 094）：send/read/wait/notify/progress 在 daemon 本地闭环，不经中心；只有
// new/list/ports 由 daemon 代问中心（Task 要落库广播、预览 URL 由中心生成）。
// 跟随 cwd（plan 102）：请求都带 process.cwd()，agent 挪进同设备另一个 coflux 工作区后，这些
// 命令就对那个工作区办事（notify/progress/ports 除外，它们挂在本会话上，与工作区无关）。
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

async function agentPost(body) {
  const portResult = localGatewayPort();
  if (!portResult.ok) die(portResult.error);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${portResult.port}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, pid: process.pid, ppid: process.ppid, cwd: callerCwd() }),
      signal: AbortSignal.timeout(agentTimeoutMs()),
    });
  } catch (error) {
    die(`连不上本机 daemon：${error?.message || error}（daemon 没在跑？查看 Coflux.app 或 cofluxd status）`);
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

/** ` busy` / ` idle` plus ` last=<code>` for a live, instrumented terminal; nothing otherwise. */
function commandSuffix(t) {
  if (!t.integrated) return "";
  const last = t.lastCommandExitCode === undefined || t.lastCommandExitCode === null ? "" : ` last=${t.lastCommandExitCode}`;
  return `${t.busy ? " busy" : " idle"}${last}`;
}

/** "do script": type a command into a terminal once its shell signalled prompt readiness. */
async function runCommand(taskId, command) {
  const result = await agentPost({ action: "terminal.run", taskId, command });
  console.log(`已打入命令 #${result.commandSeq}（coflux terminal wait ${taskId} 等它结束，coflux terminal read ${taskId} 看输出）`);
}

async function cmdTerminal(values) {
  const sub = positionals[1];
  if (sub === "new") {
    // Open first, then "do script": the terminal exists (and is reported) even when the command
    // cannot be typed — an old daemon refuses terminal.run as an unknown action and never runs
    // the command any other way. --cmd missing and --cmd= blank are the same: nothing is typed.
    const command = (values.cmd ?? "").trim() ? values.cmd : "";
    const result = await agentPost({ action: "terminal.new", title: values.title || "" });
    console.log(`已开终端 ${result.taskId}（用户可在 coflux 侧栏看到并随时接管）`);
    if (command) {
      await runCommand(result.taskId, command);
    } else {
      console.log(`常驻的登录 shell（全 tty），不会自己退出`);
      console.log(`跑命令：coflux terminal run ${result.taskId} --cmd="<命令>"（等提示符就绪后打入，wait 可等它结束）`);
      console.log(`看输出：coflux terminal read ${result.taskId}；结束：coflux terminal close ${result.taskId}`);
    }
  } else if (sub === "run") {
    const taskId = positionals[2];
    if (!taskId) die("terminal run 需要 <taskId>（用 coflux terminal list 查）");
    const command = (values.cmd ?? "").trim() ? values.cmd : "";
    if (!command) die(`terminal run 需要 --cmd="<命令>"`);
    await runCommand(taskId, command);
  } else if (sub === "close") {
    const taskId = positionals[2];
    if (!taskId) die("terminal close 需要 <taskId>（用 coflux terminal list 查）");
    const result = await agentPost({ action: "terminal.close", taskId });
    if (result.exited) {
      const exit = result.exitCode === undefined || result.exitCode === null ? "" : ` exit=${result.exitCode}`;
      console.log(`已关闭终端 ${taskId}（exited${exit}）`);
    } else {
      console.log(`已请求关闭终端 ${taskId}，shell 仍在退出中（coflux terminal list 可查）`);
    }
  } else if (sub === "list") {
    const { terminals } = await agentPost({ action: "terminal.list" });
    if (!terminals.length) return void console.log("本工作区暂无终端");
    for (const t of terminals) {
      const exit = t.exitCode === undefined || t.exitCode === null ? "" : ` exit=${t.exitCode}`;
      console.log(`${t.taskId}  ${t.status}${exit}${commandSuffix(t)}  ${t.title}`);
    }
  } else if (sub === "read") {
    const taskId = positionals[2];
    if (!taskId) die("terminal read 需要 <taskId>（用 coflux terminal list 查）");
    const requested = Number(values.lines);
    const lines = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_READ_LINES;
    const result = await agentPost({ action: "terminal.read", taskId });
    const exit = result.exitCode === undefined || result.exitCode === null ? "" : ` exit=${result.exitCode}`;
    console.log(`# ${result.status}${exit}`);
    const text = tailLines(stripAnsi(result.ansi), lines);
    console.log(text || "（暂无输出）");
  } else if (sub === "send") {
    const taskId = positionals[2];
    if (!taskId) die("terminal send 需要 <taskId>（用 coflux terminal list 查）");
    const text = values.text ?? "";
    if (!text && !values.enter) die(`terminal send 需要 --text "<文本>"（或至少 --enter 发一个回车）`);
    await agentPost({ action: "terminal.send", taskId, text, enter: Boolean(values.enter) });
    console.log(`已写入终端 ${taskId}（用 coflux terminal read ${taskId} 核对效果）`);
  } else if (sub === "wait") {
    const taskId = positionals[2];
    if (!taskId) die("terminal wait 需要 <taskId>（用 coflux terminal list 查）");
    const requested = Number(values.timeout);
    const timeoutSec = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WAIT_TIMEOUT_S;
    const seq = Number(values.seq);
    const commandSeq = Number.isInteger(seq) && seq > 0 ? seq : 0;
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      // Each round blocks inside the daemon (its command-state watch wakes it the moment the
      // command ends); a `running` answer only means the round elapsed.
      const roundMs = Math.min(WAIT_ROUND_MS, Math.max(1, deadline - Date.now()));
      const t = await agentPost({ action: "terminal.wait", taskId, commandSeq, timeoutMs: roundMs });
      if (t.state !== "running") {
        const exit = t.exitCode === undefined || t.exitCode === null ? "" : ` exit=${t.exitCode}`;
        return void console.log(`# ${t.state === "exited" ? "exited" : "finished"}${exit}`);
      }
      if (Date.now() >= deadline) {
        die(`等待超时（${timeoutSec}s）：终端 ${taskId} 的命令 #${t.commandSeq} 仍在运行。可加大 --timeout，或 coflux terminal read ${taskId} 看现场`);
      }
    }
  } else {
    die(`terminal 需要子命令：new | run | list | read | wait | send | close`);
  }
}

async function cmdNotify() {
  const message = positionals.slice(1).join(" ").trim();
  if (!message) die(`notify 需要一句话，例如：coflux notify "两个方案拿不准，需要你定"`);
  await agentPost({ action: "notify", message });
  console.log("已通知用户（工作区在侧栏转为「等待交互」）");
}

async function cmdProgress() {
  const message = positionals.slice(1).join(" ").trim();
  if (!message) die(`progress 需要一句话，例如：coflux progress "复现了，正在定位 relay 重连"`);
  await agentPost({ action: "progress", message });
  console.log("已更新进度（显示在工作区卡片上，被下一条覆盖）");
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
    return void console.log(JSON.stringify({
      workspaceId: result.workspaceId,
      path: result.path,
      owningWorkspaceId: result.owningWorkspaceId,
      moved: Boolean(result.moved),
    }));
  }
  if (sub === "locate") {
    // 路径缺省取调用方 cwd；插件脚本一律显式传 hook 载荷里的 cwd（hook 在会话当前目录执行，
    // 与载荷里的 cwd 未必相同）。
    const path = positionals[2] || callerCwd();
    if (!path) die("workspace locate 需要 <path>（取不到当前目录）");
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
    if (!path) die("workspace forget 需要 <path>（被删掉的 worktree 目录）");
    const result = await agentPost({ action: "workspace.forget", path });
    return void console.log(JSON.stringify({
      workspaceId: result.workspaceId,
      fallbackWorkspaceId: result.fallbackWorkspaceId,
      movedTerminals: result.movedTerminals ?? 0,
      removed: Boolean(result.removed),
    }));
  }
  die(`workspace 的子命令只有 enter | locate | forget（不带子命令 = 报出我在哪）`);
}

async function cmdPorts() {
  const { ports } = await agentPost({ action: "ports" });
  if (!ports.length) return void console.log("本工作区暂无监听端口");
  for (const p of ports) console.log(`${p.port}  ${p.url}`);
}

const HELP = `coflux —— 账号与终端操作
  coflux hook <claude|codex>   [agent hook 信使] 读 stdin/argv 的事件 JSON，转发给本机 daemon
                          （在 claude/codex 的 hook 配置里指向本命令；失败静默，不干扰 agent）

  以下几条供**跑在 coflux 终端里的 agent** 调用，把工作变成用户看得见、能接管的东西：

  coflux terminal new [--title="<标题>"] [--cmd="<命令>"]
                          开一个真实终端：工作区目录下的常驻登录 shell，stdin/stdout 都是真 tty，
                          用户在 coflux 侧栏能看到并随时接管，直到输入 exit 或 close 才结束
                          带 --cmd = 等 shell 提示符就绪后把命令打进去（终端继续活着），等于 new + run
  coflux terminal run <taskId> --cmd="<命令>"
                          往已开的终端里打一条命令（提示符就绪后才打入；上一条还在跑时拒绝）
  coflux terminal wait <taskId> [--timeout=<秒>] [--seq=<N>]
                          阻塞等到当前（或第 N 条）命令结束，打印它的退出码：# finished exit=<code>；
                          shell 自己退出则打印 # exited exit=<code>（默认超时 30 分钟）
  coflux terminal read <taskId> [--lines=N]
                          读终端滚动缓冲的尾部（纯文本，默认最后 200 行，可远超一屏）
  coflux terminal send <taskId> --text="<文本>" [--enter]
                          往终端里输入文本（--enter 追加回车）。用户正在接管时会被拒
  coflux terminal list   列出本工作区的终端（含 status / 退出码，跑着的还带 busy|idle 与上一条命令的退出码）
  coflux terminal close <taskId>
                          结束该终端（等价账号 CLI 的 stop）
  coflux notify "<一句话>"  叫人：工作区在侧栏转为「等待交互」并显示这句话
  coflux progress "<一句话>"  播报进度：显示在工作区卡片上，被下一条覆盖（不打扰用户）
  coflux ports           列出本工作区的监听端口及可直接打开的预览 URL
  coflux workspace       一行 JSON 报出「我在哪」：workspaceId（cwd 所在的有效工作区，本地命令
                          都落在它上面）、path、owningWorkspaceId（本终端此刻归属哪个工作区）、
                          moved。用 /cd 挪进另一个 coflux 工作区后用它确认目标，跨工作区操作时也传这个
                          workspaceId
  coflux workspace enter <path>
                          进入同仓库工作区并迁移当前终端；受管 Codex 会话记住选择供恢复/压缩使用。
                          后续工具必须显式使用返回路径；不会改变宿主默认 cwd 或沙箱权限
  coflux workspace locate [path]
                          把本终端的**归属**搬到 path（缺省=当前目录）所属的工作区：进入/离开
                          worktree 后 coflux 跟着走，未登记的同仓库 worktree 先登记出一个子工作区。
                          插件自动调，一般不用手敲
  coflux workspace forget <path>
                          该 worktree 已被删掉：其下所有终端搬回项目主工作区、工作区记录消失
                          （不执行 git worktree remove）

agent 命令的环境变量：COFLUX_AGENT_TIMEOUT_MS 收窄单次请求的等待上限（默认 30000，只能调小），
供有硬超时的 hook 脚本用——到点干净失败，好过被宿主杀在半路。

账号命令（JSON 输出）：
  coflux login --username <账号> --password-stdin [--server https://…]
  coflux whoami | logout
  coflux device list | project list | workspace list
  coflux workspace new --project <id> --branch <分支> [--existing-branch]
  coflux workspace rename <id> --name <名称> | workspace remove <id>
  coflux terminal new --workspace <id> [--cmd <命令>]
  coflux terminal run|read|send|wait|stop|remove <id> --remote
  coflux terminal list [--device <id>] [--workspace <id>]（跑着的终端带 busy / lastCommandExitCode，经 checkpoint 滞后 ≤2 秒）
  coflux ports --remote
  已登录的 Coflux 应用可供 CLI 直接使用；独立 CLI 可自行登录。
`;
const { values, positionals } = parseArgs({
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
    text: { type: "string" },
    enter: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const cmd = positionals[0];
if (values.help || cmd === "help" || !cmd) { console.log(HELP); process.exit(0); }
if (handlesAccountCommand(positionals, values, HOME)) {
  try { await runAccountCommand(positionals, values, HOME); } catch (error) { die(error.message); }
  process.exit(0);
}
const handlers = { hook: cmdHook, terminal: cmdTerminal, notify: cmdNotify, progress: cmdProgress, ports: cmdPorts, workspace: cmdWorkspace };
const handler = handlers[cmd];
if (!handler) die(`未知命令: ${cmd}\n本机宿主请使用 Coflux.app 或 cofluxd。\n\n${HELP}`);
await handler(values);
