/**
 * plan 102 / 103：Claude 插件的 UserPromptSubmit 挪窝脚本（integrations/claude-plugin/scripts/session-moved.mjs）。
 * 纯单元，不起栈：子进程跑脚本，喂 env + stdin JSON，PATH 上只放一个**假 cofluxd**，看 stdout。
 *
 * 契约：`cofluxd workspace` 报出的**有效**工作区与**归属**工作区不同 → stdout 是一个
 * <coflux-session-moved>…</coflux-session-moved> 纯文本块，含两个工作区 id、有效工作区路径，并说明本地命令
 * 会落到哪、MCP 该传哪个 workspaceId、COFLUX_TASK_ID/COFLUX_SESSION_ID 不变；其它一切情形（两者相同、
 * 不在 coflux 里、stdin 非 JSON、cofluxd 缺失或失败）→ 零字节 stdout、退出 0。
 *
 * plan 104 起两个 id **都**来自 cofluxd：`$COFLUX_WORKSPACE_ID` 只当「在不在 coflux 里」的门。coflux 跟随
 * agent 进 worktree 之后归属真的会变，那个环境变量就过期了——拿它当归属比对，会在搬完之后每条 prompt 误报。
 *
 * 夹具纪律（plan 098 的返修教训）：假 cofluxd 单独一个目录，PATH 只含它——否则测试会打到真 daemon，
 * 把测试文案写进用户自己的工作区卡片。假 cofluxd 顺手把自己的 cwd 写进 marker，用来证明脚本是按
 * **载荷里的 cwd** 调它，而不是脚本自己的 process.cwd()。
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
const SCRIPT = `${PLUGIN}scripts/session-moved.mjs`;

/** 假 cofluxd 的**唯一**所在目录；测试里 PATH 就是它 */
let fakeDir;
/** 载荷里的 cwd：与脚本自己的 cwd（ROOT）刻意不同 */
let workDir;
/** 假 cofluxd 把自己被调用时的 cwd 写在这里 */
let marker;

const MOVED = JSON.stringify({
  workspaceId: "ws-b",
  path: "/Users/me/.coflux/worktrees/ws-b",
  owningWorkspaceId: "ws-a",
  moved: true,
});
const SAME = JSON.stringify({ workspaceId: "ws-a", path: "/repo", owningWorkspaceId: "ws-a", moved: false });

before(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "coflux-moved-bin-"));
  workDir = await mkdtemp(join(tmpdir(), "coflux-moved-cwd-"));
  marker = join(fakeDir, "called-from.txt");
  const fake = join(fakeDir, "cofluxd");
  await writeFile(
    fake,
    ["#!/bin/sh", 'pwd > "$FAKE_MARKER"', 'if [ "$FAKE_FAIL" = "1" ]; then exit 1; fi', 'printf "%s\\n" "$FAKE_OUTPUT"', ""].join("\n"),
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

const prompt = (cwd) => ({ hook_event_name: "UserPromptSubmit", prompt: "继续", session_id: "s-1", cwd });

test("挪窝了：输出 <coflux-session-moved> 块，两个工作区 id、路径与该传给 MCP 的 id 都在里面", async () => {
  await rm(marker, { force: true });
  const { code, stdout, stderr } = await run({
    stdin: prompt(workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: MOVED },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "", "不该有 stderr");
  const lines = stdout.split("\n");
  assert.equal(lines[0], "<coflux-session-moved>", `块必须以标签开头: ${JSON.stringify(stdout.slice(0, 40))}`);
  assert.equal(lines.at(-2), "</coflux-session-moved>", "块必须以闭合标签结尾");
  assert.equal(lines.at(-1), "", "以换行结尾");
  assert.ok(stdout.includes("ws-b"), `要给出有效工作区 id: ${stdout}`);
  assert.ok(stdout.includes("ws-a"), `要给出归属工作区 id: ${stdout}`);
  assert.ok(stdout.includes("/Users/me/.coflux/worktrees/ws-b"), `要给出有效工作区路径: ${stdout}`);
  assert.match(stdout, /cofluxd/, "要说明本地命令落到哪");
  assert.match(stdout, /workspaceId/, "要说明 MCP 该传哪个 id");
  assert.match(stdout, /COFLUX_TASK_ID/, "要说明 task/session 不变");
  assert.match(stdout, /COFLUX_SESSION_ID/);
  assert.doesNotMatch(stdout.trimStart(), /^[[{]/, "stdout 不能像 JSON（宿主会当决策解析）");

  const calledFrom = (await readFile(marker, "utf8")).trim();
  assert.equal(
    realpathSync(calledFrom),
    realpathSync(workDir),
    "必须用载荷里的 cwd 调 cofluxd，而不是脚本自己的 process.cwd()",
  );
});

test("判据是 cofluxd 报的两个 id，不看 moved 字段", async () => {
  const { code, stdout } = await run({
    stdin: prompt(workDir),
    env: {
      COFLUX_WORKSPACE_ID: "ws-a",
      FAKE_OUTPUT: JSON.stringify({ workspaceId: "ws-b", path: "/x", owningWorkspaceId: "ws-a", moved: false }),
    },
  });
  assert.equal(code, 0);
  assert.ok(stdout.startsWith("<coflux-session-moved>"), stdout);
});

test("plan 104：归属来自 cofluxd 而不是 $COFLUX_WORKSPACE_ID——coflux 跟随进 worktree 后不再误报", async () => {
  // 终端开在 ws-a，coflux 已经跟着 agent 把归属搬到 ws-b：环境变量还是 ws-a（spawn 时写死，改不了），
  // 但有效 == 归属 == ws-b，脚本必须闭嘴。拿 env 当归属就会在搬完之后每条 prompt 都喊一次「挪窝了」。
  const { code, stdout, stderr } = await run({
    stdin: prompt(workDir),
    env: {
      COFLUX_WORKSPACE_ID: "ws-a",
      FAKE_OUTPUT: JSON.stringify({ workspaceId: "ws-b", path: "/x", owningWorkspaceId: "ws-b", moved: false }),
    },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", `归属已搬到 ws-b，不该报挪窝: ${JSON.stringify(stdout)}`);
  assert.equal(stderr, "");
});

test("没挪窝：有效工作区就是归属工作区 → 零字节、退出 0", async () => {
  const { code, stdout, stderr } = await run({
    stdin: prompt(workDir),
    env: { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: SAME },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "", `不该有任何输出: ${JSON.stringify(stdout)}`);
  assert.equal(stderr, "");
});

test("不在 coflux 里：没有 COFLUX_WORKSPACE_ID → 零字节，且根本不去调 cofluxd", async () => {
  await rm(marker, { force: true });
  for (const [label, env] of [
    ["无任何 COFLUX_* 变量", { FAKE_OUTPUT: MOVED }],
    ["COFLUX_WORKSPACE_ID 为空串", { COFLUX_WORKSPACE_ID: "", FAKE_OUTPUT: MOVED }],
    ["只有项目 id", { COFLUX_PROJECT_ID: "proj-1", FAKE_OUTPUT: MOVED }],
  ]) {
    const { code, stdout } = await run({ stdin: prompt(workDir), env });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
  assert.equal(existsSync(marker), false, "不在 coflux 里连子进程都不该起");
});

test("载荷坏了：非 JSON、空 stdin、缺 cwd 都零字节", async () => {
  for (const [label, stdin] of [
    ["非 JSON", "{not json"],
    ["空 stdin", ""],
    ["缺 cwd", { hook_event_name: "UserPromptSubmit", prompt: "hi" }],
    ["cwd 是空串", { hook_event_name: "UserPromptSubmit", cwd: "" }],
    ["cwd 不是字符串", { hook_event_name: "UserPromptSubmit", cwd: 42 }],
  ]) {
    const { code, stdout } = await run({ stdin, env: { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: MOVED } });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
});

test("cofluxd 不在/失败/输出不是 JSON：一律零字节、退出 0，绝不干扰 agent", async () => {
  const cases = [
    ["cofluxd 不在 PATH 上", { PATH: join(fakeDir, "empty"), COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: MOVED }],
    ["cofluxd 返回非零", { COFLUX_WORKSPACE_ID: "ws-a", FAKE_FAIL: "1", FAKE_OUTPUT: MOVED }],
    ["cofluxd 输出不是 JSON", { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: "daemon 没在跑" }],
    ["cofluxd 回的 workspaceId 为空", { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: JSON.stringify({ workspaceId: "", owningWorkspaceId: "ws-a" }) }],
    ["cofluxd 回的 owningWorkspaceId 为空（旧 daemon）", { COFLUX_WORKSPACE_ID: "ws-a", FAKE_OUTPUT: JSON.stringify({ workspaceId: "ws-b", path: "/x" }) }],
  ];
  for (const [label, env] of cases) {
    const { code, stdout } = await run({ stdin: prompt(workDir), env });
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
  }
});

test("插件配置：UserPromptSubmit 里信使在前、挪窝脚本在后且缺 node 静默；版本 ≥ 0.10.0；SKILL 讲清两种工作区", () => {
  const hooks = JSON.parse(readFileSync(`${PLUGIN}hooks/hooks.json`, "utf8"));
  const entries = hooks.hooks.UserPromptSubmit;
  assert.ok(Array.isArray(entries) && entries.length === 2, "UserPromptSubmit 两条：信使 + 挪窝脚本");
  assert.match(entries[0].hooks[0].command, /cofluxd hook claude/, "信使必须仍是第一条（既有用例按 find 取它）");
  const moved = entries[1].hooks[0];
  assert.equal(moved.type, "command");
  assert.match(moved.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/session-moved\.mjs/);
  assert.match(moved.command, /command -v node/, "缺 node 要静默");
  assert.equal(entries[1].matcher, undefined, "不设 matcher");

  const manifest = JSON.parse(readFileSync(`${PLUGIN}.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 10, `插件版本必须 ≥ 0.10.0: ${manifest.version}`);

  for (const path of [`${PLUGIN}skills/coflux/SKILL.md`, `${ROOT}packages/cli/skills/coflux/SKILL.md`]) {
    const skill = readFileSync(path, "utf8");
    assert.match(skill, /cofluxd workspace/, `${path} 要写 cofluxd workspace 的用法`);
    assert.match(skill, /<coflux-session-moved>/, `${path} 要提到挪窝块`);
    assert.match(skill, /EnterWorktree/, `${path} 要说明 /cd 与 EnterWorktree 会挪窝`);
    assert.match(skill, /effective/i, `${path} 要区分归属工作区与有效工作区`);
  }
  // 坐标块要指向 cofluxd workspace，而不是让 agent 自己拿环境变量当归属
  const context = readFileSync(`${PLUGIN}scripts/session-context.sh`, "utf8");
  assert.match(context, /cwd/, "SessionStart 块要以 cwd 所在的工作区为准");
  assert.match(context, /cofluxd workspace/, "SessionStart 块要指向 cofluxd workspace");
});
