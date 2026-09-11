/**
 * plan 095 / 103：Claude 插件的 PreToolUse 拦截脚本（integrations/claude-plugin/scripts/guard-git-worktree.mjs）。
 * 纯单元，不起栈：子进程跑脚本，喂 env + stdin JSON，看 stdout。
 *
 * 契约：coflux 项目会话（COFLUX_PROJECT_ID 非空）里 Bash 命令含 `git … worktree remove|move` → stdout 是一段
 * 纯 JSON 的 deny 决策，理由里带 remove_workspace 与项目 id；其它一切情形（`add`、无项目 id、只读子命令、
 * 非 Bash、坏 JSON）→ 零输出、退出 0，绝不误拦。
 *
 * plan 104 起 `add` 放行：coflux 会跟随 agent 进入 worktree（EnterWorktree/ExitWorktree/resume/清理都搬归属，
 * 未登记的先登记），自建 worktree 不再对用户不可见，拦它只会把任务打断。`remove|move` 仍拦——手工删掉目录
 * 会留下没人清理的孤儿工作区记录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = `${ROOT}integrations/claude-plugin/scripts/guard-git-worktree.mjs`;

function run(stdin, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      { env: { PATH: process.env.PATH, ...env }, timeout: 10000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const IN_PROJECT = { COFLUX_PROJECT_ID: "proj-123", COFLUX_WORKSPACE_ID: "ws-1" };

test("coflux 项目会话里 git worktree remove/move 被 deny，理由可操作", async () => {
  for (const command of [
    "git worktree remove ../x",
    "cd /repo && git worktree remove ../x",
    "git -C /repo worktree remove ../x",
    "git --no-pager worktree move ../a ../b",
    "GIT_DIR=/repo/.git git worktree remove /tmp/wt; ls",
  ]) {
    const { code, stdout } = await run(bash(command), IN_PROJECT);
    assert.equal(code, 0, `退出码必须是 0（${command}）`);
    let decision;
    assert.doesNotThrow(() => { decision = JSON.parse(stdout); }, `stdout 必须是纯 JSON（${command}）: ${JSON.stringify(stdout)}`);
    assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", command);
    const reason = decision.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /proj-123/, "理由要带项目 id，agent 能直接填");
    assert.match(reason, /coflux workspace remove/, "理由要指向替代做法");
  }
  const remove = JSON.parse((await run(bash("git worktree remove ../feat"), IN_PROJECT)).stdout);
  const removeReason = remove.hookSpecificOutput.permissionDecisionReason;
  assert.match(removeReason, /coflux workspace remove/);
  assert.match(removeReason, /orphan/i, "理由要说清为什么不能手工删：留下孤儿记录");
  const move = JSON.parse((await run(bash("git worktree move ../a ../b"), IN_PROJECT)).stdout);
  assert.match(move.hookSpecificOutput.permissionDecisionReason, /coflux workspace remove/);
});

test("plan 104：git worktree add 一律放行——coflux 会跟着 agent 进去，不再需要拦", async () => {
  for (const command of [
    "git worktree add ../feat -b feat",
    "cd /repo && git worktree add ../x main",
    "git -C /repo worktree add ../x",
    "git --no-pager worktree add /tmp/wt",
    "git worktree add .claude/worktrees/fix-a -b worktree-fix-a",
  ]) {
    const { code, stdout } = await run(bash(command), IN_PROJECT);
    assert.equal(code, 0, command);
    assert.equal(stdout, "", `add 必须零输出（放行）：${command} → ${JSON.stringify(stdout)}`);
  }
});

test("不误拦：无项目 id、只读子命令、非 Bash、坏 JSON、普通命令都零输出", async () => {
  const silent = async (stdin, env, label) => {
    const { code, stdout } = await run(stdin, env);
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  };
  await silent(bash("git worktree remove ../feat"), {}, "不在 coflux 项目里");
  await silent(bash("git worktree remove ../feat"), { COFLUX_PROJECT_ID: "", COFLUX_WORKSPACE_ID: "ws-dir" }, "目录工作区（项目 id 空串）");
  for (const command of ["git worktree list", "git worktree prune", "git worktree lock ../x", "git status", "ls -la", "echo worktree remove"]) {
    await silent(bash(command), IN_PROJECT, `放行：${command}`);
  }
  await silent({ ...bash("git worktree remove x"), tool_name: "Write" }, IN_PROJECT, "非 Bash 工具");
  await silent("{not json", IN_PROJECT, "坏 JSON");
  await silent("", IN_PROJECT, "空 stdin");
});

test("插件配置：hooks.json 含 matcher=Bash 的条目引用该脚本，版本严格大于 0.3.0", () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}integrations/claude-plugin/hooks/hooks.json`, "utf8"));
  const guard = hooks.hooks.PreToolUse.find((entry) => entry.matcher === "Bash");
  assert.ok(guard, "PreToolUse 里要有 matcher=Bash 的条目");
  assert.match(guard.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard-git-worktree\.mjs/);
  assert.match(guard.hooks[0].command, /command -v node/, "缺 node 要静默放行");
  const messenger = hooks.hooks.PreToolUse.find((entry) => entry.matcher === undefined);
  assert.ok(messenger && /coflux hook claude/.test(messenger.hooks[0].command), "既有信使条目不能动");
  const manifest = JSON.parse(readFileSync(`${ROOT}integrations/claude-plugin/.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 4, `插件版本必须 ≥ 0.4.0: ${manifest.version}`);
});
