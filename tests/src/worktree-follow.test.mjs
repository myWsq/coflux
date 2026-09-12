/**
 * plan 104：coflux 跟随 agent 进入 worktree——EnterWorktree / ExitWorktree / resume / WorktreeRemove 时
 * 终端的**归属**工作区搬到对应的工作区，未登记的先登记，PTY 一动不动。
 *
 * 验收核心（在真栈上驱动，命令都从 A 的 PTY 里发出，与 agent 的形态一致）：
 * - 定位到仓库里一个**未注册**的 worktree W（测试自己用 git 建的，模拟 Claude Code 自建的
 *   `<主工作区>/.claude/worktrees/<name>`）→ 中心先广播 workspaceCreated（path = W 的规范化根）
 *   再广播 taskUpdated（同一个 task，workspaceId 变成新工作区）；PTY 里 `coflux workspace` 报出的
 *   owningWorkspaceId 就是新 id；
 * - 定位回 A → taskUpdated 回 A，W 的工作区记录还在（ExitWorktree 不删子工作区）；
 * - 定位到一个**已注册**的子工作区 B → 只搬不新建；
 * - 定位到另一个仓库 / 非 git 目录 → 可读错误、零广播（会话照常）；
 * - forget W → 先 taskUpdated（终端回 A）后 workspaceRemoved，次序不能反（各端收到
 *   workspaceRemoved 会连带丢掉该工作区的 tasks）；
 * - 旧格式的 agent 控制请求（不带新字段）行为一字不变：`terminal new` 照常在当前归属工作区开终端。
 *
 * 最长前缀 vs 相等：W 就嵌在 A 的目录之下，plan 102 的最长前缀会把它算进 A，所以登记与否只能按
 * 路径**相等**判定（crates/worker/src/worktree_locate.rs）。用例 ① 建出 W 这件事本身就是证据：
 * 若按前缀判，W 会被认成 A，永远登记不出来、归属也永远不会变。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { mkRepo, startStack, CLI_BIN } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";

const PORT = 8873;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));

let stack;
const repos = [];
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-wtfollow-")));
  dirs.push(dir);
  return dir;
}

function newRepo() {
  const repo = mkRepo();
  repos.push(repo);
  return repo;
}

/** 像 Claude Code 那样在仓库里自建一个 worktree（测试进程不受插件 guard 约束）。 */
function addWorktree(repoDir, relative, branch) {
  const path = join(repoDir, relative);
  execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", branch, path], { stdio: "pipe" });
  return realpathSync(path);
}

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  repos.forEach((repo) => repo.cleanup());
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let cliSeq = 0;

for (const mode of ['locate', 'enter']) test(`${mode}: register and move workspaces without interrupting the PTY; reject unrelated paths and return on cleanup`, async () => {
  const repoA = newRepo();
  const outsideRepo = newRepo(); // 另一个仓库：定位过去必须「不适用」
  const notGit = mkDir(); // 非 git 目录：同样「不适用」
  const out = mkDir(); // CLI 输出落盘的地方（不注册成工作区）

  const device = await openNativeDevice(stack);
  const c = device.control;
  const gatewayPort = device.gateway.port;

  /** 在 A 的 PTY 里跑一条 coflux 命令，输出重定向到文件——比解析 PTY 分块输出可靠得多。 */
  const runCli = async (sessionId, args, predicate, label, timeout = 25000) => {
    const file = join(out, `cli-${cliSeq += 1}.txt`);
    await device.input(
      sessionId,
      `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} ${mode === 'enter' ? CLI_BIN : `node ${COFLUXD}`} ${args.replace(/^workspace locate /, `workspace ${mode} `)} > ${file} 2>&1\r`,
    );
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        last = readFileSync(file, "utf8");
        if (predicate(last)) return last;
      }
      await sleep(200);
    }
    throw new Error(`${label} 超时；最后内容: ${JSON.stringify(last)}`);
  };
  /** cofluxd 的这几条命令的契约就是「一行 JSON」——解析不出来本身就是失败，且要把原文带出来。 */
  const json = async (sessionId, args, label) => {
    const raw = (await runCli(sessionId, args, (s) => s.includes("{") || s.includes("✗"), label)).trim();
    const line = raw.split("\n").filter(Boolean).pop();
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} 没拿到一行 JSON: ${raw}`);
    }
  };
  /** 某条广播在 client 消息日志里的位置；-1 = 还没出现。次序断言就靠它。 */
  const indexOf = (predicate) => c.log.findIndex(predicate);

  // ---- 布景：导入 A，开一个终端并接上 PTY ----
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repoA.dir });
  const project = await c.waitFor((m) => m.case === "projectCreated", "项目导入", 30000);
  const mainWs = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "A 主工作区", 30000);
  const wsA = mainWs.workspace;
  await device.waitWorkspaceReady(wsA.id, 20000);

  c.send({ case: "taskCreate", workspaceId: wsA.id, title: "follow-me" });
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "follow-me", "终端建好");
  const taskId = idle.task.id;
  c.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const running = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING,
    "终端跑起来",
    20000,
  );
  const sessionId = running.task.sessionId;
  await device.attach(sessionId);

  // 已注册的子工作区 B 必须经中心建（daemon 真的 git worktree add，路径才进得了工作区表）
  c.send({ case: "workspaceCreate", projectId: project.project.id, name: "sibling", branch: "sibling", createNew: true });
  const createdB = await c.waitFor(
    (m) => m.case === "workspaceCreated" && !m.workspace.isMain && m.workspace.branch === "sibling",
    "B 子工作区建好",
    30000,
  );
  const wsB = createdB.workspace;
  await device.waitWorkspaceReady(wsB.id, 20000);

  // Claude Code 自建的 worktree：coflux 完全不知道它的存在，且它嵌在 A 的目录之下
  const worktreeW = addWorktree(repoA.dir, join(".claude", "worktrees", "fix-a"), "worktree-fix-a");

  let wsW;
  try {
    // ---- ① 定位到未注册的 W：先登记（workspaceCreated），再搬归属（taskUpdated） ----
    const located = await json(sessionId, `workspace locate ${worktreeW}`, "定位到 W");
    if (mode === 'enter') {
      assert.equal(located.hostCwdChanged, false);
      assert.equal(located.resumeSupported, false, 'plain terminals have no Codex conversation identity');
      assert.match(located.instruction, /workdir\/cwd/);
    }
    assert.equal(located.created, true, `W 未注册过，必须新登记: ${JSON.stringify(located)}`);
    assert.equal(located.moved, true, `归属必须真的搬了: ${JSON.stringify(located)}`);
    assert.equal(located.branch, "worktree-fix-a", `分支要取 W 自己的: ${JSON.stringify(located)}`);

    const createdW = await c.waitFor(
      (m) => m.case === "workspaceCreated" && m.workspace.id === located.workspaceId,
      "W 的工作区卡片出现",
      20000,
    );
    wsW = createdW.workspace;
    assert.equal(realpathSync(wsW.path), worktreeW, "登记的是规范化后的 worktree 根");
    assert.equal(wsW.isMain, false);
    assert.equal(wsW.projectId, wsA.projectId, "W 是同一个项目下的子工作区");

    const movedIn = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === located.workspaceId,
      "终端搬到 W 名下",
      20000,
    );
    assert.equal(movedIn.task.sessionId, sessionId, "PTY 不动：session 不变");
    assert.equal(movedIn.task.status, TaskStatus.RUNNING, "turn 状态连续：终端仍在跑");
    assert.equal(movedIn.task.projectId, wsA.projectId, "project 不变");
    assert.ok(
      indexOf((m) => m.case === "workspaceCreated" && m.workspace.id === wsW.id) <
        indexOf((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsW.id),
      "登记时 workspaceCreated 必须先于 taskUpdated（否则终端会短暂指向一个还不存在的工作区）",
    );

    // agent 在会话里看到的坐标已经是新的：归属 = W。cwd 仍在 A，有效工作区因此仍是 A——
    // 归属与目标是两层，这条正是它们不混的证据。
    const whereInA = await json(sessionId, "workspace", "搬完之后在 A 的 cwd 下问我在哪");
    assert.equal(whereInA.owningWorkspaceId, wsW.id, `归属必须已是 W: ${JSON.stringify(whereInA)}`);
    assert.equal(whereInA.workspaceId, wsA.id, `cwd 还在 A，有效工作区就是 A: ${JSON.stringify(whereInA)}`);

    // 登记之后 102 的最长前缀自然优先命中 W（W 的路径比 A 长），不需要为它特判
    const whereInW = await json(sessionId, `workspace locate ${worktreeW}`, "再定位一次 W（幂等）");
    assert.equal(whereInW.moved, false, `已经在 W 了，再定位必须是幂等无操作: ${JSON.stringify(whereInW)}`);
    assert.equal(whereInW.created, false, "更不能再登记一条");
    assert.equal(whereInW.workspaceId, wsW.id);

    // ---- ② 定位回 A（ExitWorktree）：终端回 A，W 的记录还在 ----
    const backToA = await json(sessionId, `workspace locate ${repoA.dir}`, "定位回 A");
    assert.deepEqual(
      { workspaceId: backToA.workspaceId, created: backToA.created, moved: backToA.moved },
      { workspaceId: wsA.id, created: false, moved: true },
      `回 A 必须是「搬回既有工作区」而不是新建: ${JSON.stringify(backToA)}`,
    );
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsA.id,
      "终端回到 A 名下",
      20000,
    );
    assert.equal(
      indexOf((m) => m.case === "workspaceRemoved" && m.workspaceId === wsW.id),
      -1,
      "ExitWorktree 不删子工作区",
    );

    // ---- ③ 定位到已注册的子工作区 B：只搬不新建 ----
    const toB = await json(sessionId, `workspace locate ${wsB.path}`, "定位到 B");
    assert.deepEqual(
      { workspaceId: toB.workspaceId, created: toB.created, moved: toB.moved },
      { workspaceId: wsB.id, created: false, moved: true },
      `B 已注册，只搬不建: ${JSON.stringify(toB)}`,
    );
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsB.id,
      "终端搬到 B 名下",
      20000,
    );
    // 搬回 A，后面的用例从 A 出发
    await json(sessionId, `workspace locate ${repoA.dir}`, "从 B 搬回 A");
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsA.id,
      "终端回到 A 名下（第二次）",
      20000,
    );

    // ---- ④ 别的仓库 / 非 git 目录：可读错误、零广播 ----
    const workspacesBefore = c.log.filter((m) => m.case === "workspaceCreated").length;
    for (const [label, path, hint] of [
      ["另一个 git 仓库", outsideRepo.dir, /另一个 git 仓库/],
      ["非 git 目录", notGit, /不是 git 仓库/],
    ]) {
      const text = await runCli(sessionId, `workspace locate ${path}`, (s) => s.includes("✗"), `定位到${label}`);
      assert.match(text, /✗/, `${label} 必须报错而不是静默改归属: ${text}`);
      assert.match(text, hint, `${label} 的错误要说清为什么不适用: ${text}`);
    }
    await sleep(500); // 给「万一真广播了」一点到达时间
    assert.equal(
      c.log.filter((m) => m.case === "workspaceCreated").length,
      workspacesBefore,
      "不适用的定位不能建出任何工作区",
    );
    const stillInA = await json(sessionId, "workspace", "不适用之后归属没动");
    assert.equal(stillInA.owningWorkspaceId, wsA.id, `归属必须还在 A: ${JSON.stringify(stillInA)}`);

    // ---- ⑤ 旧格式请求行为不变：不带任何新字段的 terminal new 照常在当前归属工作区开终端 ----
    const newText = await runCli(sessionId, `terminal new --title "老路径"`, (s) => s.includes("已开终端") || s.includes("✗"), "老路径开终端");
    assert.match(newText, /已开终端/, `旧格式请求必须一字不变地继续工作: ${newText}`);
    const legacy = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "老路径", "老路径的终端出现", 20000);
    assert.equal(legacy.task.workspaceId, wsA.id, "没申报目标工作区时仍落在发起方的归属工作区");

    // ---- ⑥ worktree 被删：终端先回 A（taskUpdated），再 workspaceRemoved ----
    // 先把终端搬进 W，才验得出「它下面的终端真的回到主工作区」
    await json(sessionId, `workspace locate ${worktreeW}`, "再进 W 一次");
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsW.id,
      "终端再次搬到 W 名下",
      20000,
    );
    // Claude Code 退出时自己清干净 worktree：目录先消失，coflux 才收到事件
    execFileSync("git", ["-C", repoA.dir, "worktree", "remove", "--force", worktreeW], { stdio: "pipe" });
    const beforeForget = c.log.length;
    const forgotten = await json(sessionId, `workspace forget ${worktreeW}`, "W 已删");
    assert.equal(forgotten.workspaceId, wsW.id, JSON.stringify(forgotten));
    assert.equal(forgotten.fallbackWorkspaceId, wsA.id, "终端要回到项目主工作区");
    assert.equal(forgotten.removed, true);
    assert.ok(forgotten.movedTerminals >= 1, `至少本终端要被搬回去: ${JSON.stringify(forgotten)}`);

    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsA.id,
      "W 下的终端回到主工作区",
      20000,
    );
    await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === wsW.id, "W 的卡片消失", 20000);
    // 次序只看这一次「已删」之后的消息，不受前面几轮搬动的干扰
    const tail = c.log.slice(beforeForget);
    const backIndex = tail.findIndex((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.workspaceId === wsA.id);
    const removedIndex = tail.findIndex((m) => m.case === "workspaceRemoved" && m.workspaceId === wsW.id);
    assert.ok(backIndex >= 0, "终端必须被搬回主工作区并广播 taskUpdated");
    assert.ok(removedIndex >= 0, "工作区记录必须消失");
    assert.ok(
      backIndex < removedIndex,
      `删记录时 taskUpdated 必须先于 workspaceRemoved（各端收到 workspaceRemoved 会连带丢掉该工作区的 tasks）：taskUpdated@${backIndex} vs workspaceRemoved@${removedIndex}`,
    );

    // 终端还活着：搬来搬去一次都没打断 PTY
    const after = await json(sessionId, "workspace", "全程结束后我在哪");
    assert.equal(after.owningWorkspaceId, wsA.id, `最终归属回到 A: ${JSON.stringify(after)}`);
    wsW = undefined;
  } finally {
    // 清理：删掉黑盒建出来的工作区记录，避免污染同一个 stack 上的后续用例
    if (wsW) {
      c.send({ case: "workspaceRemove", workspaceId: wsW.id });
      await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === wsW.id, "清理 W", 20000).catch(() => {});
    }
    device.close();
  }
});
