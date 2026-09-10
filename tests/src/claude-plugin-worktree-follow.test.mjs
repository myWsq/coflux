/**
 * plan 103：Claude 插件的 worktree 跟随脚本（integrations/claude-plugin/scripts/worktree-follow.mjs）。
 * 纯单元，不起栈：子进程跑脚本，喂 env + stdin JSON，PATH 上只放一个**假 cofluxd**，看 stdout。
 *
 * 契约：
 * - PostToolUse + tool_name ∈ {EnterWorktree, ExitWorktree} → 用**载荷里的 cwd** 调 `cofluxd workspace locate <cwd>`；
 *   归属真的搬了（moved=true）→ stdout 是一段纯 JSON 的 PostToolUse 决策，additionalContext 里带新坐标；
 * - WorktreeRemove → 用载荷里的 worktree_path 调 `cofluxd workspace forget <path>`，stdout 零字节；
 *   载荷里的 cwd 已经被删掉（那正是刚被清理的 worktree）时照样调得出去——路径永远走参数，子进程的
 *   工作目录只挑一个还在的；cwd 不存在就把 forget 吞掉，正好漏掉这个 hook 唯一要干的事；
 * - 其它一切情形 → 零字节 stdout、退出 0：没搬（同工作区）、不在 coflux 里、stdin 非 JSON、事件/工具不对、
 *   cofluxd 缺失 / 返回非零（含旧 daemon 的「未知 action」）/ 输出不是 JSON。绝不干扰 agent。
 *
 * 夹具纪律（plan 098 的返修教训）：假 cofluxd 单独一个目录、PATH 只含它——否则测试会打到真 daemon，
 * 真的把用户某个终端的归属搬走、甚至删掉一个工作区记录。假 cofluxd 顺手把自己的 cwd 与参数写进 marker，
 * 用来证明脚本是按载荷里的 cwd 调它，而不是脚本自己的 process.cwd()。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN = `${ROOT}integrations/claude-plugin/`;
const SCRIPT = `${PLUGIN}scripts/worktree-follow.mjs`;

/** 假 cofluxd 的**唯一**所在目录；测试里 PATH 就是它 */
let fakeDir;
/** 载荷里的 cwd：与脚本自己的 cwd（ROOT）刻意不同 */
let workDir;
/** 假 cofluxd 把「被调用时的 cwd」与「收到的参数」写在这里 */
let marker;

const MOVED = JSON.stringify({
  workspaceId: "ws-worktree",
  path: "/repo/.claude/worktrees/fix-a",
  branch: "worktree-fix-a",
  created: true,
  moved: true,
});
const BACK = JSON.stringify({
  workspaceId: "ws-main",
  path: "/repo",
  branch: "main",
  created: false,
  moved: true,
});
const SAME = JSON.stringify({ workspaceId: "ws-main", path: "/repo", branch: "main", created: false, moved: false });
const FORGOTTEN = JSON.stringify({ workspaceId: "ws-worktree", fallbackWorkspaceId: "ws-main", movedTerminals: 2, removed: true });

before(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "coflux-follow-bin-"));
  workDir = await mkdtemp(join(tmpdir(), "coflux-follow-cwd-"));
  marker = join(fakeDir, "called.txt");
  const fake = join(fakeDir, "cofluxd");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      '{ pwd; echo "$@"; } > "$FAKE_MARKER"',
      'if [ "$FAKE_FAIL" = "1" ]; then printf "%s\\n" "$FAKE_OUTPUT" >&2; exit 1; fi',
      'printf "%s\\n" "$FAKE_OUTPUT"',
      "",
    ].join("\n"),
  );
  await chmod(fake, 0o755);
});

after(async () => {
  // 只删 mktemp 给的两个路径
  if (fakeDir) await rm(fakeDir, { recursive: true, force: true });
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function run({ stdin, env = {} }) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      {
        // 脚本自己的 cwd 是仓库根，载荷里的 cwd 是 workDir：两者必须区分得开
        cwd: ROOT,
        env: { PATH: fakeDir, FAKE_MARKER: marker, FAKE_OUTPUT: "", ...env },
        timeout: 15000,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    // 脚本可能在写入前就退出（不在 coflux 里）：EPIPE 不算失败
    child.stdin.on("error", () => {});
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

const postToolUse = (tool, cwd) => ({
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: {},
  tool_response: {},
  session_id: "s-1",
  cwd,
});
const worktreeRemove = (path, cwd) => ({
  hook_event_name: "WorktreeRemove",
  worktree_path: path,
  session_id: "s-1",
  cwd,
});

/** marker 的两行：被调用时的 cwd、收到的参数。 */
async function called() {
  const [cwd, args] = (await readFile(marker, "utf8")).trim().split("\n");
  return { cwd, args };
}

test("EnterWorktree 搬了归属：用载荷里的 cwd 调 `workspace locate`，stdout 是纯 JSON 决策、additionalContext 带新坐标", async () => {
  await rm(marker, { force: true });
  const { code, stdout, stderr } = await run({
    stdin: postToolUse("EnterWorktree", workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: MOVED },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "", "不该有 stderr");

  const { cwd: calledFrom, args } = await called();
  assert.equal(
    realpathSync(calledFrom),
    realpathSync(workDir),
    "必须用载荷里的 cwd 调 cofluxd，而不是脚本自己的 process.cwd()",
  );
  assert.equal(args, `workspace locate ${workDir}`, "路径也要显式传，不能指望子进程 cwd");

  let decision;
  assert.doesNotThrow(() => { decision = JSON.parse(stdout); }, `stdout 必须是纯 JSON: ${JSON.stringify(stdout)}`);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PostToolUse");
  const context = decision.hookSpecificOutput.additionalContext;
  assert.ok(typeof context === "string" && context.startsWith("<coflux-workspace-changed>"), context);
  assert.ok(context.trimEnd().endsWith("</coflux-workspace-changed>"), context);
  assert.match(context, /ws-worktree/, "要给出新的归属工作区 id");
  assert.match(context, /\/repo\/\.claude\/worktrees\/fix-a/, "要给出新工作区路径");
  assert.match(context, /worktree-fix-a/, "要给出分支");
  assert.match(context, /registered/i, "新登记出来的工作区要说明一句（用户侧栏会多一张卡片）");
  assert.match(context, /COFLUX_WORKSPACE_ID/, "要点明那个环境变量已经过期");
  assert.match(context, /COFLUX_TASK_ID/, "要说明 task/session 不变");
  assert.match(context, /workspaceId/, "要说明 MCP 该传哪个 id");
});

test("ExitWorktree 搬回去：同样回注坐标，created=false 时不说「刚登记」", async () => {
  await rm(marker, { force: true });
  const { code, stdout } = await run({
    stdin: postToolUse("ExitWorktree", workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: BACK },
  });
  assert.equal(code, 0);
  const { args } = await called();
  assert.equal(args, `workspace locate ${workDir}`);
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /ws-main/);
  assert.doesNotMatch(context, /registered/i, "没新建就别说新建");
});

test("没搬（cwd 就是当前归属）：零字节、退出 0——正常启动与幂等的 Exit 都落在这里", async () => {
  const { code, stdout, stderr } = await run({
    stdin: postToolUse("EnterWorktree", workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: SAME },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", `不该有任何输出: ${JSON.stringify(stdout)}`);
  assert.equal(stderr, "");
});

test("WorktreeRemove：用载荷里的 worktree_path 调 `workspace forget`，stdout 零字节", async () => {
  await rm(marker, { force: true });
  const removed = join(workDir, ".claude", "worktrees", "fix-a");
  const { code, stdout, stderr } = await run({
    stdin: worktreeRemove(removed, workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: FORGOTTEN },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", `WorktreeRemove 没有工具结果可注解，必须零字节: ${JSON.stringify(stdout)}`);
  assert.equal(stderr, "");
  const { cwd: calledFrom, args } = await called();
  assert.equal(args, `workspace forget ${removed}`, "要传被删掉的 worktree 路径，而不是 cwd");
  assert.equal(realpathSync(calledFrom), realpathSync(workDir), "仍从载荷里的 cwd 调 cofluxd");
});

test("载荷里的 cwd 已被删掉：forget 照样发得出去（从一个还在的目录起子进程）", async () => {
  // Claude Code 清 worktree 时会话的 cwd 通常就是那个刚被删掉的目录。以它作 execFile 的 cwd
  // 会在命令还没跑起来就 ENOENT，脚本一吞，工作区记录就成了永远没人清的孤儿——正是本 hook 存在的理由。
  await rm(marker, { force: true });
  const gone = join(workDir, "already-removed");
  assert.equal(existsSync(gone), false, "这个目录本来就不该存在");
  // HOME 显式钉成一个存在的目录，好断言退路选的就是它（os.homedir() 优先看 $HOME）
  const { code, stdout, stderr } = await run({
    stdin: worktreeRemove(gone, gone),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: FORGOTTEN, HOME: workDir },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", JSON.stringify(stdout));
  assert.equal(stderr, "");
  const { cwd: calledFrom, args } = await called();
  assert.equal(args, `workspace forget ${gone}`, "被删掉的路径仍要作为参数传过去");
  assert.equal(existsSync(calledFrom), true, `退路目录必须真的存在: ${calledFrom}`);
  assert.notEqual(realpathSync(calledFrom), gone, "子进程不能从一个不存在的目录起");
  assert.equal(realpathSync(calledFrom), realpathSync(workDir), "退路是 HOME（HOME 也没了才是 /）");
});

test("PostToolUse 的 cwd 已被删掉：明说不去定位（不存在的目录本来也定位不出什么）", async () => {
  await rm(marker, { force: true });
  const gone = join(workDir, "vanished");
  const { code, stdout } = await run({
    stdin: postToolUse("EnterWorktree", gone),
    env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: MOVED },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", JSON.stringify(stdout));
  assert.equal(existsSync(marker), false, "不存在的 cwd 连子进程都不该起");
});

test("WorktreeRemove 缺 worktree_path：零字节，且根本不去调 cofluxd", async () => {
  await rm(marker, { force: true });
  for (const payload of [
    { hook_event_name: "WorktreeRemove", session_id: "s-1", cwd: workDir },
    { hook_event_name: "WorktreeRemove", worktree_path: "", cwd: workDir },
    { hook_event_name: "WorktreeRemove", worktree_path: 42, cwd: workDir },
  ]) {
    const { code, stdout } = await run({ stdin: payload, env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: FORGOTTEN } });
    assert.equal(code, 0);
    assert.equal(stdout, "", JSON.stringify(stdout));
  }
  assert.equal(existsSync(marker), false, "没有路径就不该起子进程");
});

test("不相干的事件与工具：零字节，且不去调 cofluxd", async () => {
  await rm(marker, { force: true });
  for (const [label, payload] of [
    ["别的工具", postToolUse("Bash", workDir)],
    ["工具名缺失", { hook_event_name: "PostToolUse", cwd: workDir }],
    ["PreToolUse 的 EnterWorktree", { ...postToolUse("EnterWorktree", workDir), hook_event_name: "PreToolUse" }],
    ["事件名缺失", { tool_name: "EnterWorktree", cwd: workDir }],
    ["PostToolUse 缺 cwd", { hook_event_name: "PostToolUse", tool_name: "EnterWorktree" }],
    ["cwd 是空串", postToolUse("EnterWorktree", "")],
  ]) {
    const { code, stdout } = await run({ stdin: payload, env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: MOVED } });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
  assert.equal(existsSync(marker), false, "这些情形连子进程都不该起");
});

test("不在 coflux 里：没有 COFLUX_WORKSPACE_ID → 零字节，且根本不去调 cofluxd", async () => {
  await rm(marker, { force: true });
  for (const [label, env] of [
    ["无任何 COFLUX_* 变量", { FAKE_OUTPUT: MOVED }],
    ["COFLUX_WORKSPACE_ID 为空串", { COFLUX_WORKSPACE_ID: "", FAKE_OUTPUT: MOVED }],
    ["只有项目 id", { COFLUX_PROJECT_ID: "proj-1", FAKE_OUTPUT: MOVED }],
  ]) {
    const { code, stdout } = await run({ stdin: postToolUse("EnterWorktree", workDir), env });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
  assert.equal(existsSync(marker), false, "不在 coflux 里连子进程都不该起");
});

test("载荷坏了：非 JSON、空 stdin 都零字节", async () => {
  for (const [label, stdin] of [
    ["非 JSON", "{not json"],
    ["空 stdin", ""],
    ["JSON 但不是对象", "42"],
  ]) {
    const { code, stdout } = await run({ stdin, env: { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: MOVED } });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
});

test("cofluxd 不在 / 失败 / 旧 daemon / 输出不是 JSON：一律零字节、退出 0，绝不干扰 agent", async () => {
  for (const [label, env] of [
    ["cofluxd 不在 PATH 上", { PATH: join(fakeDir, "empty"), COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: MOVED }],
    ["中心拒绝（别的仓库 / 非 git / 目录工作区）", { COFLUX_WORKSPACE_ID: "ws-main", FAKE_FAIL: "1", FAKE_OUTPUT: "✗ 目标 worktree 属于另一个 git 仓库" }],
    ["daemon 旧到不认识该动作", { COFLUX_WORKSPACE_ID: "ws-main", FAKE_FAIL: "1", FAKE_OUTPUT: "✗ 未知 action workspace.locate" }],
    ["cofluxd 输出不是 JSON", { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: "daemon 没在跑" }],
    ["cofluxd 回的 workspaceId 为空", { COFLUX_WORKSPACE_ID: "ws-main", FAKE_OUTPUT: JSON.stringify({ workspaceId: "", moved: true }) }],
  ]) {
    const { code, stdout } = await run({ stdin: postToolUse("EnterWorktree", workDir), env });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
});

test("插件配置：PostToolUse 里信使在前、跟随脚本 matcher=EnterWorktree|ExitWorktree；WorktreeRemove 引同一脚本；版本 ≥ 0.10.0", () => {
  const hooks = JSON.parse(readFileSync(`${PLUGIN}hooks/hooks.json`, "utf8"));
  const post = hooks.hooks.PostToolUse;
  assert.ok(Array.isArray(post) && post.length === 2, "PostToolUse 两条：信使 + 跟随脚本");
  assert.match(post[0].hooks[0].command, /cofluxd hook claude/, "信使必须仍是第一条（既有用例按 find 取它）");
  assert.equal(post[0].matcher, undefined);
  const follow = post[1];
  assert.equal(follow.matcher, "EnterWorktree|ExitWorktree", "只在这两个工具上触发；Codex 没有它们，天然零影响");
  assert.equal(follow.hooks[0].type, "command");
  assert.match(follow.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/worktree-follow\.mjs/);
  assert.match(follow.hooks[0].command, /command -v node/, "缺 node 要静默");

  const remove = hooks.hooks.WorktreeRemove;
  assert.ok(Array.isArray(remove) && remove.length === 1, "WorktreeRemove 恰好一条");
  assert.equal(remove[0].matcher, undefined, "不设 matcher");
  assert.match(remove[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/worktree-follow\.mjs/);
  assert.match(remove[0].hooks[0].command, /command -v node/);

  const manifest = JSON.parse(readFileSync(`${PLUGIN}.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 10, `插件版本必须 ≥ 0.10.0: ${manifest.version}`);
});

test("SKILL 唯一源与插件副本都讲清「进 worktree coflux 会跟随、删仍走 remove_workspace」", () => {
  for (const path of [`${PLUGIN}skills/coflux/SKILL.md`, `${ROOT}packages/cli/skills/coflux/SKILL.md`]) {
    const skill = readFileSync(path, "utf8");
    assert.match(skill, /EnterWorktree/, `${path} 要说明 EnterWorktree 会让 coflux 跟随`);
    assert.match(skill, /follows you into a git worktree/i, `${path} 要有「coflux 跟随进 worktree」这一节`);
    assert.match(skill, /remove_workspace/, `${path} 要把删工作区引导到 remove_workspace`);
    assert.match(skill, /cofluxd workspace/, `${path} 要写 cofluxd workspace 的用法`);
    assert.doesNotMatch(
      skill,
      /Never run `git worktree add` yourself/,
      `${path} 不能再说「绝不要自己 git worktree add」——103 起它是放行的`,
    );
  }
});
