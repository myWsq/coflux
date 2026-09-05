/**
 * plan 095：Claude 插件的 PreToolUse 拦截脚本（integrations/claude-plugin/scripts/guard-git-worktree.mjs）。
 * 纯单元，不起栈：子进程跑脚本，喂 env + stdin JSON，看 stdout。
 *
 * 契约：coflux 项目会话（COFLUX_PROJECT_ID 非空）里 Bash 命令含 `git … worktree add|remove|move` → stdout 是一段
 * 纯 JSON 的 deny 决策，理由里带 create_workspace / remove_workspace 与项目 id；其它一切情形（无项目 id、只读
 * 子命令、非 Bash、坏 JSON）→ 零输出、退出 0，绝不误拦。
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

test("coflux 项目会话里 git worktree add/remove/move 被 deny，理由可操作", async () => {
  for (const command of [
    "git worktree add ../feat -b feat",
    "cd /repo && git worktree add ../x main",
    "git -C /repo worktree remove ../x",
    "git --no-pager worktree move ../a ../b",
    "GIT_DIR=/repo/.git git worktree add /tmp/wt; ls",
  ]) {
    const { code, stdout } = await run(bash(command), IN_PROJECT);
    assert.equal(code, 0, `退出码必须是 0（${command}）`);
    let decision;
    assert.doesNotThrow(() => { decision = JSON.parse(stdout); }, `stdout 必须是纯 JSON（${command}）: ${JSON.stringify(stdout)}`);
    assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", command);
    const reason = decision.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /proj-123/, "理由要带项目 id，agent 能直接填");
    assert.match(reason, /create_workspace|remove_workspace/, "理由要指向替代做法");
  }
  const add = JSON.parse((await run(bash("git worktree add ../feat"), IN_PROJECT)).stdout);
  assert.match(add.hookSpecificOutput.permissionDecisionReason, /create_workspace/);
  const remove = JSON.parse((await run(bash("git worktree remove ../feat"), IN_PROJECT)).stdout);
  assert.match(remove.hookSpecificOutput.permissionDecisionReason, /remove_workspace/);
});

test("不误拦：无项目 id、只读子命令、非 Bash、坏 JSON、普通命令都零输出", async () => {
  const silent = async (stdin, env, label) => {
    const { code, stdout } = await run(stdin, env);
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  };
  await silent(bash("git worktree add ../feat"), {}, "不在 coflux 项目里");
  await silent(bash("git worktree add ../feat"), { COFLUX_PROJECT_ID: "", COFLUX_WORKSPACE_ID: "ws-dir" }, "目录工作区（项目 id 空串）");
  for (const command of ["git worktree list", "git worktree prune", "git worktree lock ../x", "git status", "ls -la", "echo worktree add"]) {
    await silent(bash(command), IN_PROJECT, `放行：${command}`);
  }
  await silent({ ...bash("git worktree add x"), tool_name: "Write" }, IN_PROJECT, "非 Bash 工具");
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
  assert.ok(messenger && /cofluxd hook claude/.test(messenger.hooks[0].command), "既有信使条目不能动");
  const manifest = JSON.parse(readFileSync(`${ROOT}integrations/claude-plugin/.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 4, `插件版本必须 ≥ 0.4.0: ${manifest.version}`);
});
