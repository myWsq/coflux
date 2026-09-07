/**
 * plan 098：Claude 插件的「不可见后台进程外化」两个 hook 脚本。
 * 纯单元，不起栈：子进程跑脚本，喂 env + stdin JSON，看 stdout。
 *
 * 契约（PreToolUse，guard-background-bash.mjs）：coflux 工作区会话（COFLUX_WORKSPACE_ID 非空）里
 * `Bash(run_in_background: true)` → stdout 是一段纯 JSON 的 deny 决策，理由里带可直接执行的
 * `cofluxd terminal new --title=… --cmd=…`；含 `cofluxd terminal` 的与 `sleep` 开头的豁免；其它一切情形
 * （无工作区 id、非 Bash、坏 JSON、非后台调用）→ 零输出、退出 0，绝不误拦。
 *
 * 契约（PostToolUse，report-background-task.mjs）：无论如何 stdout 都必须零字节（PostToolUse 的 stdout
 * 会被当上下文注入，且 Codex 也执行这套 hooks.json）；认得出泄漏字段才调 cofluxd progress 播报。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = `${ROOT}integrations/claude-plugin/scripts/guard-background-bash.mjs`;
const REPORTER = `${ROOT}integrations/claude-plugin/scripts/report-background-task.mjs`;

function run(script, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script],
      { env: { PATH: process.env.PATH, ...env }, timeout: 10000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

const bg = (command, description) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description, run_in_background: true },
  cwd: "/repo",
});
const IN_WORKSPACE = { COFLUX_WORKSPACE_ID: "ws-1", COFLUX_PROJECT_ID: "proj-123" };

async function deny(stdin, env = IN_WORKSPACE) {
  const { code, stdout } = await run(GUARD, stdin, env);
  assert.equal(code, 0, "hook 退出码必须是 0");
  let decision;
  assert.doesNotThrow(() => { decision = JSON.parse(stdout); }, `stdout 必须是纯 JSON: ${JSON.stringify(stdout)}`);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  return decision.hookSpecificOutput.permissionDecisionReason;
}

test("coflux 会话里显式后台 Bash 被 deny，理由是可直接照做的 terminal new", async () => {
  const reason = await deny(bg("pnpm -C tests test", "Run unit tests"));
  assert.match(reason, /cofluxd terminal new/, "理由要给出替代命令");
  assert.match(reason, /--title='Run unit tests'/, "标题取自 agent 自己写的 description");
  assert.match(reason, /--cmd='pnpm -C tests test'/, "命令用 --cmd=<值> 形式，值以 - 开头也不会被 parseArgs 吃掉");
  assert.match(reason, /ws-1/, "理由要带工作区 id，说明这是 coflux 会话");
  assert.match(reason, /cofluxd terminal wait/, "要教它后台跑 wait 拿回退出唤醒");
  assert.match(reason, /cofluxd terminal read/, "被唤醒后要读结果");
  assert.match(reason, /exit=/, "要说明成败看 # exited exit=N");
  assert.match(reason, /foreground/i, "要明确写「也不要退而求其次改成前台跑」");
});

test("deny 理由里的替代命令做了 shell 引号转义，缺 description 时退回命令本身", async () => {
  const command = "echo 'it''s fine' && ls";
  const quoted = await deny(bg(command, "Say hi"));
  // POSIX 单引号里塞单引号只有 '\'' 一种写法；照抄出来的命令必须能原样跑。
  const expected = `--cmd='${command.replaceAll("'", "'\\''")}'`;
  assert.ok(quoted.includes(expected), `单引号要转义成 '\\'' 才能直接跑，缺: ${expected}\n实际理由: ${quoted}`);
  const noDescription = await deny(bg("pnpm dev"));
  assert.match(noDescription, /--title='pnpm dev'/, "没有 description 就用命令本身兜底");
  assert.doesNotMatch(noDescription, /--title=''/, "标题不能是空串");
});

test("超长命令不硬塞进理由：给出占位与 16 KB 上限的说明", async () => {
  const long = `echo ${"x".repeat(9000)}`;
  const reason = await deny(bg(long, "Echo a lot"));
  assert.doesNotMatch(reason, /x{9000}/, "超过内联阈值的命令不该整段抄进理由");
  assert.match(reason, /16 KB/, "要说明命令行有 16 KB 上限");
  assert.match(reason, /cofluxd terminal new/, "仍然要指向 terminal new");
});

test("豁免：含 cofluxd terminal 的命令与 sleep 开头的命令不拦", async () => {
  for (const command of [
    "cofluxd terminal wait task-1",
    "cofluxd terminal wait task-1 --timeout 600",
    "/usr/local/bin/cofluxd terminal new --title='x' --cmd='y'",
    "sleep 30",
    "sleep 5 && echo done",
    "  sleep 120",
  ]) {
    const { code, stdout } = await run(GUARD, bg(command, "whatever"), IN_WORKSPACE);
    assert.equal(code, 0, command);
    assert.equal(stdout, "", `豁免命令不该有任何输出（${command}）: ${JSON.stringify(stdout)}`);
  }
});

test("不误拦：非 coflux 会话、非 Bash、坏 JSON、非后台调用都零输出", async () => {
  const silent = async (stdin, env, label) => {
    const { code, stdout } = await run(GUARD, stdin, env);
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  };
  await silent(bg("pnpm dev", "Start dev server"), {}, "不在 coflux 工作区里");
  await silent(bg("pnpm dev", "Start dev server"), { COFLUX_WORKSPACE_ID: "" }, "工作区 id 是空串");
  await silent(bg("pnpm dev", "Start dev server"), { COFLUX_WORKSPACE_ID: "   " }, "工作区 id 全是空白");
  await silent({ ...bg("pnpm dev", "x"), tool_name: "Write" }, IN_WORKSPACE, "非 Bash 工具");
  await silent(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } },
    IN_WORKSPACE,
    "前台调用（没有 run_in_background 字段）",
  );
  for (const value of [false, "true", 1, null]) {
    await silent(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test", run_in_background: value } },
      IN_WORKSPACE,
      `run_in_background 不是布尔真（${JSON.stringify(value)}）`,
    );
  }
  await silent({ ...bg("   ", "空命令"), tool_input: { command: "   ", run_in_background: true } }, IN_WORKSPACE, "空命令");
  await silent({ hook_event_name: "PreToolUse", tool_name: "Bash" }, IN_WORKSPACE, "没有 tool_input");
  await silent("{not json", IN_WORKSPACE, "坏 JSON");
  await silent("", IN_WORKSPACE, "空 stdin");
});

/* ---------------- PostToolUse：不可见后台任务的播报器 ---------------- */

// 只删 mkdtemp 自己返回的那个路径，且必须在系统临时目录下。
function removeTempDir(dir) {
  if (dir && dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}

// 一次性的临时 bin 目录。**必须 async + await fn**：fn 是异步的，同步 try/finally 会在 fn 刚返回
// Promise（hook 子进程还没 spawn）时就把目录删掉，假 cofluxd 于是永远不被调用、日志恒不存在，
// 断言「调用 0 次」的用例全部假绿，断言「调用 1 次」的全部误红。
async function withTempBin(makeBin, fn) {
  const dir = mkdtempSync(join(tmpdir(), "coflux-098-"));
  try {
    return await fn({ dir, ...makeBin(dir) });
  } finally {
    removeTempDir(dir);
  }
}

// 假 cofluxd：把 argv 记进日志，同时往 stdout 打一行——用来验证 hook 确实把子进程的 stdout 丢掉了。
function fakeCofluxd(dir) {
  const log = join(dir, "calls.log");
  const bin = join(dir, "cofluxd");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho "已广播给用户"\n`);
  chmodSync(bin, 0o755);
  return { log };
}

async function report(stdin, env = IN_WORKSPACE) {
  return withTempBin(fakeCofluxd, async ({ dir, log }) => {
    // PATH **只有**假目录，绝不拼 process.env.PATH：hook 脚本本身是用 process.execPath 的绝对路径
    // 起的（不需要 PATH 找 node），脚本内部只用 PATH 找 cofluxd。这样 fixture 一旦再出问题，结果是
    // 测试红，而不是静悄悄打到本机真 daemon、把播报文案写进用户真实工作区的卡片。
    const { code, stdout } = await run(REPORTER, stdin, { ...env, PATH: dir });
    assert.equal(code, 0, "PostToolUse hook 退出码必须是 0");
    assert.equal(stdout, "", `PostToolUse 的 stdout 必须零字节（会被当上下文注入）: ${JSON.stringify(stdout)}`);
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  });
}

const post = (toolResponse, { command = "pnpm build", description = "Build the app" } = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command, description },
  tool_response: toolResponse,
  tool_use_id: "toolu_1",
});

test("前台命令超时被自动后台化：认出泄漏字段，用 progress 播报给用户", async () => {
  const calls = await report(post({ stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg_1", timedOutAfterMs: 120000 }));
  assert.equal(calls.length, 1, `应当只播报一次: ${JSON.stringify(calls)}`);
  assert.match(calls[0], /^progress /, "必须走 progress（广播），不是 notify（叫人）");
  assert.match(calls[0], /Build the app/, "要带上 agent 自己写的 description");
  assert.match(calls[0], /120s/, "超时后台化要说明是超时导致的");
  assert.match(calls[0], /cannot see|no terminal/i, "要说清这是用户看不见的后台任务");
});

test("显式后台（绕过了 deny）也播报，但措辞不提超时", async () => {
  const calls = await report(post({ stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg_2" }));
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /timeout/i, "没有 timedOutAfterMs 就不该说是超时");
  assert.match(calls[0], /Build the app/);
});

test("tool_response 被包成数组时同样认得出", async () => {
  const calls = await report(post([{ stdout: "", stderr: "", backgroundTaskId: "bg_3", timedOutAfterMs: 5000 }]));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /5s/);
});

test("零动作：普通前台结果、用户自己 Ctrl+B、两类豁免命令", async () => {
  const silent = async (stdin, label, env) => {
    const calls = await report(stdin, env);
    assert.deepEqual(calls, [], `${label} 不该调 cofluxd: ${JSON.stringify(calls)}`);
  };
  await silent(post({ stdout: "ok", stderr: "", interrupted: false, isImage: false }), "普通前台命令");
  await silent(post({ stdout: "", stderr: "", backgroundTaskId: "" }), "backgroundTaskId 是空串");
  await silent(post({ stdout: "", stderr: "", backgroundTaskId: "bg_4", backgroundedByUser: true }), "用户自己按 Ctrl+B 后台化的");
  await silent(
    post({ stdout: "", stderr: "", backgroundTaskId: "bg_5" }, { command: "cofluxd terminal wait task-1", description: "Wait" }),
    "豁免：后台跑 cofluxd terminal wait 正是我们教的配方",
  );
  await silent(
    post({ stdout: "", stderr: "", backgroundTaskId: "bg_6", timedOutAfterMs: 120000 }, { command: "sleep 600", description: "Sleep" }),
    "豁免：sleep 开头",
  );
});

test("PostToolUse 播报器：非 coflux 会话、非 Bash、坏 JSON 一律零输出零动作", async () => {
  const bgResponse = { stdout: "", stderr: "", backgroundTaskId: "bg_7", timedOutAfterMs: 120000 };
  assert.deepEqual(await report(post(bgResponse), {}), [], "不在 coflux 工作区里");
  assert.deepEqual(await report(post(bgResponse), { COFLUX_WORKSPACE_ID: "" }), [], "工作区 id 是空串");
  assert.deepEqual(await report({ ...post(bgResponse), tool_name: "Task" }), [], "非 Bash 工具");
  assert.deepEqual(await report({ hook_event_name: "PostToolUse", tool_name: "Bash" }), [], "没有 tool_response");
  assert.deepEqual(await report({ ...post(bgResponse), tool_response: "moved to background" }), [], "tool_response 不是对象");
  assert.deepEqual(await report("{not json"), [], "坏 JSON");
  assert.deepEqual(await report(""), [], "空 stdin");
});

test("缺 cofluxd 时静默：不报错、stdout 仍是零字节", async () => {
  // PATH 指向一个确定为空的临时目录，而不是赌真实 PATH 里恰好没有 cofluxd。
  await withTempBin(() => ({}), async ({ dir }) => {
    const { code, stdout } = await run(
      REPORTER,
      post({ stdout: "", stderr: "", backgroundTaskId: "bg_8", timedOutAfterMs: 120000 }),
      { ...IN_WORKSPACE, PATH: dir },
    );
    assert.equal(code, 0, "PATH 里没有 cofluxd 也必须干净退出");
    assert.equal(stdout, "", `不该有任何输出: ${JSON.stringify(stdout)}`);
  });
});

test("插件配置：hooks.json 里 guard-background-bash 与既有条目并存，版本 ≥ 0.6.0", () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}integrations/claude-plugin/hooks/hooks.json`, "utf8"));
  const bashEntries = hooks.hooks.PreToolUse.filter((entry) => entry.matcher === "Bash");
  const background = bashEntries.find((entry) => /guard-background-bash\.mjs/.test(entry.hooks[0].command));
  assert.ok(background, "PreToolUse 里要有跑 guard-background-bash.mjs 的 matcher=Bash 条目");
  assert.match(background.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard-background-bash\.mjs/);
  assert.match(background.hooks[0].command, /command -v node/, "缺 node 要静默放行");
  assert.ok(
    bashEntries.some((entry) => /guard-git-worktree\.mjs/.test(entry.hooks[0].command)),
    "既有的 worktree guard 条目不能被替换",
  );
  const messenger = hooks.hooks.PreToolUse.find((entry) => entry.matcher === undefined);
  assert.ok(messenger && /cofluxd hook claude/.test(messenger.hooks[0].command), "既有信使条目不能动");
  assert.ok(
    hooks.hooks.PostToolUse.some((entry) => entry.matcher === undefined && /cofluxd hook claude/.test(entry.hooks[0].command)),
    "PostToolUse 的信使条目不能动",
  );
  const reporter = hooks.hooks.PostToolUse.find((entry) => entry.matcher === "Bash");
  assert.ok(reporter, "PostToolUse 里要有 matcher=Bash 的播报器条目");
  assert.match(reporter.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/report-background-task\.mjs/);
  assert.match(reporter.hooks[0].command, /command -v node/, "缺 node 要静默放行");
  assert.match(hooks.description, /run_in_background/, "description 要说明新行为");
  const manifest = JSON.parse(readFileSync(`${ROOT}integrations/claude-plugin/.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 6, `插件版本必须 ≥ 0.6.0: ${manifest.version}`);
});

test("SKILL 教了「开终端 → 后台跑 wait → 被唤醒后 read」这条配方", () => {
  const skill = readFileSync(`${ROOT}packages/cli/skills/coflux/SKILL.md`, "utf8");
  assert.match(skill, /run_in_background/, "要点明被拦的是显式后台 Bash");
  assert.match(skill, /cofluxd terminal wait/, "配方要出现 wait");
  assert.match(skill, /--cmd=/, "样例一律写 --cmd=<值> 形式");
  assert.doesNotMatch(skill, /--cmd\s+"/, "不能再出现 --cmd \"…\" 的分离形式");
  assert.match(skill, /# exited exit=/, "要写明成败看 # exited exit=N");
  const plugin = readFileSync(`${ROOT}integrations/claude-plugin/skills/coflux/SKILL.md`, "utf8");
  assert.equal(plugin, skill, "两份 SKILL 必须一致（node scripts/sync-claude-plugin.mjs）");
});

test("插件目录全英文：没有汉字", () => {
  const files = [
    "integrations/claude-plugin/hooks/hooks.json",
    "integrations/claude-plugin/.claude-plugin/plugin.json",
    "integrations/claude-plugin/scripts/guard-background-bash.mjs",
    "integrations/claude-plugin/scripts/report-background-task.mjs",
    "integrations/claude-plugin/skills/coflux/SKILL.md",
  ];
  for (const file of files) {
    const text = readFileSync(`${ROOT}${file}`, "utf8");
    assert.doesNotMatch(text, /[一-鿿]/, `${file} 里不能有汉字（096 定的插件目录全英文约定）`);
  }
});
