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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = `${ROOT}integrations/claude-plugin/scripts/guard-background-bash.mjs`;

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
    "integrations/claude-plugin/skills/coflux/SKILL.md",
  ];
  for (const file of files) {
    const text = readFileSync(`${ROOT}${file}`, "utf8");
    assert.doesNotMatch(text, /[一-鿿]/, `${file} 里不能有汉字（096 定的插件目录全英文约定）`);
  }
});
