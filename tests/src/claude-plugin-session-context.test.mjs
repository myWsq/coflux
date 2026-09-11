/**
 * plan 096 / 103：Claude 插件的 SessionStart 注入脚本（integrations/claude-plugin/scripts/session-context.sh）。
 * 纯单元，不起栈：子进程用 sh 跑脚本，喂 env，看 stdout。
 *
 * 契约：COFLUX_WORKSPACE_ID 非空 → stdout 是一个 <coflux-session>…</coflux-session> 纯文本块，六个 COFLUX_* 变量
 * 逐行 KEY=value、一条分工规则、一个指向 skill 的指针；其它情形（变量为空/不存在）→ 零输出、退出 0。
 * 纯文本 stdout 在 Claude Code 与 Codex 的 SessionStart 里都直接进模型上下文，所以块必须以 "<" 开头、绝不像 JSON。
 *
 * plan 104 起脚本会先调 `cofluxd workspace locate` 定位当前目录（resume 一个曾进入 worktree 的会话时，
 * SessionStart 是唯一能发现它的时机），并用响应里的 workspaceId 打块；cofluxd 缺失/失败/输出不是 JSON/
 * 迟迟不答时回退到环境变量。**打块永远优先于定位**：宿主按秒杀 hook，被杀在半路等于这次会话一个坐标
 * 都拿不到，比报一个过期 id 坏得多，所以定位有自己的硬预算（shell 看门狗，不指望 timeout(1)）。
 *
 * 夹具纪律（plan 098 的返修教训）：假 cofluxd 单独一个目录并排在 PATH 最前——否则测试会打到真 daemon，
 * 真的把用户某个终端的归属搬走。PATH 里另加 /usr/bin:/bin 只为脚本用得上 sed，真 cofluxd 不装在那儿。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN = `${ROOT}integrations/claude-plugin/`;
const SCRIPT = `${PLUGIN}scripts/session-context.sh`;
/** 脚本要用 sed；真 cofluxd 不会装在这两个目录里，所以带上它们不会破坏隔离。 */
const SYSTEM_PATH = "/usr/bin:/bin";

/** 假 cofluxd 的**唯一**所在目录 */
let fakeDir;
/** 假 cofluxd 把自己收到的参数写在这里 */
let marker;

before(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "coflux-ctx-bin-"));
  marker = join(fakeDir, "called-with.txt");
  const fake = join(fakeDir, "cofluxd");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      'echo "$@" > "$FAKE_MARKER"',
      // 先落 marker 再睡：挂死的用例照样验得出「确实调了」
      'if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi',
      'if [ "$FAKE_FAIL" = "1" ]; then exit 1; fi',
      'printf "%s\\n" "$FAKE_OUTPUT"',
      "",
    ].join("\n"),
  );
  await chmod(fake, 0o755);
});

after(async () => {
  // 只删 mktemp 给的那个路径
  if (fakeDir) await rm(fakeDir, { recursive: true, force: true });
});

function run(env = {}, { withCofluxd = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sh",
      [SCRIPT],
      {
        env: {
          PATH: withCofluxd ? `${fakeDir}:${SYSTEM_PATH}` : SYSTEM_PATH,
          FAKE_MARKER: marker,
          FAKE_OUTPUT: "",
          ...env,
        },
        timeout: 10000,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    // 脚本只读环境变量，可能在 stdin 写入前退出；仍以进程退出码和输出判定结果。
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s-1", cwd: "/repo" }));
  });
}

const INSIDE = {
  COFLUX_DEVICE_ID: "dev-1",
  COFLUX_PROJECT_ID: "proj-123",
  COFLUX_WORKSPACE_ID: "ws-9",
  COFLUX_TASK_ID: "task-7",
  COFLUX_SESSION_ID: "sess-5",
  COFLUX_MCP_URL: "https://center.example/mcp",
};
const LOCATED_SAME = JSON.stringify({ workspaceId: "ws-9", path: "/repo", branch: "main", created: false, moved: false });

test("coflux 终端里：输出 <coflux-session> 块，五个坐标逐行、带分工规则与 skill 指针", async () => {
  const { code, stdout, stderr } = await run({ ...INSIDE, FAKE_OUTPUT: LOCATED_SAME });
  assert.equal(code, 0);
  assert.equal(stderr, "", "不该有 stderr");
  const lines = stdout.split("\n");
  assert.equal(lines[0], "<coflux-session>", `块必须以标签开头（宿主才不会当 JSON 解析）: ${JSON.stringify(stdout.slice(0, 40))}`);
  assert.equal(lines.at(-2), "</coflux-session>", "块必须以闭合标签结尾");
  assert.equal(lines.at(-1), "", "以换行结尾");
  for (const [key, value] of Object.entries(INSIDE)) {
    if (key === "COFLUX_MCP_URL") continue;
    assert.ok(lines.includes(`${key}=${value}`), `缺 ${key}=${value} 这一行: ${stdout}`);
  }
  assert.match(stdout, /cofluxd terminal/, "要点名本地命令");
  assert.match(stdout, /cofluxd progress|cofluxd notify|cofluxd ports/, "要点名播报/叫人/端口命令");
  assert.doesNotMatch(stdout, /MCP/, "不再注入已移除的 MCP 指引");
  assert.match(stdout, /cofluxd workspace list\/new/, "要把跨工作区能力引导到账号 CLI");
  assert.match(stdout, /cofluxd workspace remove/, "要把删工作区引导到 cofluxd workspace remove");
  assert.match(stdout, /worktree/, "要告诉 agent 进 worktree 时 coflux 会跟随");
  assert.match(stdout, /coflux.*skill/i, "要指向 coflux skill");
  assert.doesNotMatch(stdout.trimStart(), /^[[{]/, "stdout 不能像 JSON");
  assert.ok(stdout.length < 2048, `块要短，现在 ${stdout.length} 字节`);
});

test("plan 104：先调 cofluxd workspace locate，块里的工作区 id 用它的回答（resume 进 worktree 的会话据此拿到新坐标）", async () => {
  await rm(marker, { force: true });
  const { code, stdout } = await run({
    ...INSIDE,
    FAKE_OUTPUT: JSON.stringify({ workspaceId: "ws-worktree", path: "/repo/.claude/worktrees/fix", branch: "worktree-fix", created: true, moved: true }),
  });
  assert.equal(code, 0);
  const args = (await readFile(marker, "utf8")).trim();
  assert.equal(args, "workspace locate", "SessionStart 必须调 `cofluxd workspace locate`（不带路径 = 会话当前目录）");
  const lines = stdout.split("\n");
  assert.ok(lines.includes("COFLUX_WORKSPACE_ID=ws-worktree"), `块里要报 daemon 定位出的归属工作区: ${stdout}`);
  assert.ok(!lines.includes("COFLUX_WORKSPACE_ID=ws-9"), `不能再报过期的环境变量值: ${stdout}`);
  // 其余坐标不受影响：搬的是归属工作区，终端本身没动
  assert.ok(lines.includes("COFLUX_TASK_ID=task-7"), stdout);
  assert.ok(lines.includes("COFLUX_SESSION_ID=sess-5"), stdout);
});

test("daemon 不通就回退环境变量：cofluxd 缺失 / 返回非零 / 输出不是 JSON，块照常打出来", async () => {
  for (const [label, env, options] of [
    ["cofluxd 不在 PATH 上", { ...INSIDE }, { withCofluxd: false }],
    ["cofluxd 返回非零", { ...INSIDE, FAKE_FAIL: "1", FAKE_OUTPUT: LOCATED_SAME }, {}],
    ["cofluxd 输出不是 JSON", { ...INSIDE, FAKE_OUTPUT: "✗ daemon 没在跑" }, {}],
    ["cofluxd 输出里没有 workspaceId", { ...INSIDE, FAKE_OUTPUT: JSON.stringify({ ok: false }) }, {}],
  ]) {
    const { code, stdout } = await run(env, options);
    assert.equal(code, 0, label);
    assert.ok(stdout.startsWith("<coflux-session>"), `${label} 仍要打块: ${JSON.stringify(stdout.slice(0, 60))}`);
    assert.ok(stdout.split("\n").includes("COFLUX_WORKSPACE_ID=ws-9"), `${label} 要回退到环境变量: ${stdout}`);
  }
});

test("定位迟迟不答也不能吞掉坐标块：看门狗到点放弃，块照常在 hook 超时内打出来并回退环境变量", async () => {
  // 中心慢（daemon 连着、中心不答）时 `cofluxd workspace locate` 最坏要等到 daemon 的中心超时；
  // 假 cofluxd 直接睡 8 秒模拟这一幕——比 hooks.json 里 SessionStart 的 timeout 还长。
  const hooks = JSON.parse(readFileSync(`${PLUGIN}hooks/hooks.json`, "utf8"));
  const hookTimeoutS = hooks.hooks.SessionStart[0].hooks[0].timeout;
  await rm(marker, { force: true });
  const started = Date.now();
  const { code, stdout } = await run({ ...INSIDE, FAKE_SLEEP: "8", FAKE_OUTPUT: LOCATED_SAME });
  const elapsedMs = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(stdout.startsWith("<coflux-session>"), `块必须照常打出来: ${JSON.stringify(stdout.slice(0, 60))}`);
  assert.ok(
    stdout.split("\n").includes("COFLUX_WORKSPACE_ID=ws-9"),
    `定位没答上来就回退环境变量: ${stdout}`,
  );
  assert.equal((await readFile(marker, "utf8")).trim(), "workspace locate", "确实调过 cofluxd，只是没等到");
  assert.ok(
    elapsedMs < hookTimeoutS * 1000 - 2000,
    `必须明显早于 hook 的 ${hookTimeoutS}s 超时收工，否则宿主会把整个块杀掉；实际 ${elapsedMs}ms`,
  );
});

test("目录工作区：COFLUX_PROJECT_ID 为空串照样输出，且该行为空值", async () => {
  const { code, stdout } = await run({ ...INSIDE, COFLUX_PROJECT_ID: "", FAKE_OUTPUT: LOCATED_SAME });
  assert.equal(code, 0);
  assert.ok(stdout.split("\n").includes("COFLUX_PROJECT_ID="), stdout);
  assert.ok(stdout.split("\n").includes("COFLUX_WORKSPACE_ID=ws-9"), stdout);
});

test("不在 coflux 里：变量不存在或 COFLUX_WORKSPACE_ID 为空都零输出、退出 0，且根本不去调 cofluxd", async () => {
  await rm(marker, { force: true });
  for (const [label, env] of [
    ["无任何 COFLUX_* 变量", { FAKE_OUTPUT: LOCATED_SAME }],
    ["只有项目 id 没有工作区 id", { COFLUX_PROJECT_ID: "proj-123", COFLUX_DEVICE_ID: "dev-1", FAKE_OUTPUT: LOCATED_SAME }],
    ["工作区 id 为空串", { ...INSIDE, COFLUX_WORKSPACE_ID: "", FAKE_OUTPUT: LOCATED_SAME }],
  ]) {
    const { code, stdout, stderr } = await run(env);
    assert.equal(code, 0, label);
    assert.equal(stdout, "", `${label} 不该有任何输出: ${JSON.stringify(stdout)}`);
    assert.equal(stderr, "", label);
  }
  assert.equal(existsSync(marker), false, "不在 coflux 里连 cofluxd 都不该调");
});

test("插件配置：SessionStart 条目无 matcher 且引用该脚本、缺文件静默；信使与 guard 条目不动；版本 ≥ 0.5.0；SKILL 提到块", () => {
  const hooks = JSON.parse(readFileSync(`${PLUGIN}hooks/hooks.json`, "utf8"));
  const start = hooks.hooks.SessionStart;
  assert.ok(Array.isArray(start) && start.length === 1, "SessionStart 恰好一条");
  assert.equal(start[0].matcher, undefined, "不设 matcher：startup/resume/clear/compact/fork 全触发");
  const command = start[0].hooks[0].command;
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/session-context\.sh/);
  assert.match(command, /\[ -r "\$0" \]/, "脚本缺失要静默");
  assert.equal(start[0].hooks[0].type, "command");
  // 脚本自己的定位预算（看门狗 3s）必须明显小于宿主的 hook 超时，才留得下打块的余量
  assert.ok(start[0].hooks[0].timeout >= 8, `SessionStart 的 hook 超时要给定位留余量: ${start[0].hooks[0].timeout}`);
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /LOCATE_WATCHDOG_S=3\b/, "定位要有自己的硬预算，不能只指望 CLI 的超时");
  assert.match(script, /COFLUX_AGENT_TIMEOUT_MS/, "同时让 CLI 自己早点放弃，正常路径干净收场");
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop", "StopFailure", "Notification"]) {
    const messenger = hooks.hooks[event]?.find((entry) => entry.matcher === undefined);
    assert.ok(messenger && /cofluxd hook claude/.test(messenger.hooks[0].command), `${event} 的信使条目不能动`);
  }
  assert.ok(hooks.hooks.PreToolUse.some((entry) => entry.matcher === "Bash"), "guard 条目不能动");
  const manifest = JSON.parse(readFileSync(`${PLUGIN}.claude-plugin/plugin.json`, "utf8"));
  const [major, minor] = manifest.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 5, `插件版本必须 ≥ 0.5.0: ${manifest.version}`);
  const skill = readFileSync(`${PLUGIN}skills/coflux/SKILL.md`, "utf8");
  assert.match(skill, /<coflux-session>/, "SKILL 要告诉 agent 坐标在 <coflux-session> 块里");
});

// 096 定下的约定：插件交付目录（被市场按 SHA 原样收集）里的一切文案全英文。递归扫整个目录而不是列文件名，
// 新增/删除脚本不用回来改这条用例（098 时这条用例硬编码了文件清单，099 删脚本后就失效了）。
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("插件目录全英文：没有汉字", () => {
  const files = walk(PLUGIN);
  assert.ok(files.some((file) => file.endsWith("hooks.json")) && files.some((file) => file.endsWith("SKILL.md")), "扫描范围要覆盖 hooks.json 与 SKILL.md");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /[一-鿿]/, `${file.slice(ROOT.length)} 里不能有汉字（096 定的插件目录全英文约定）`);
  }
});
