#!/usr/bin/env node
// 生成 release note（写到 stdout）：把两个 tag 之间的 commit 按 type 分组列出，再附组件版本
// 与升级须知。GitHub 的 generate_release_notes 只汇总 PR，本仓库直接 push main（无 PR），
// 于是它只能产出一行 compare 链接——changelog 的真正来源是 commit message 本身。
//   用法: GITHUB_REPOSITORY=owner/repo node scripts/release-notes.mjs <version> [prevTag]
//   自检: node scripts/release-notes.mjs --self-check   （不碰 git，CI 里跑）
// prevTag 省略时取上一个版本 tag（按 v* 时序，排除本次）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// 分组按 type 前缀（feat/fix/…），末组兜底保证没有 commit 被吞掉。
// plan 类 commit（chore(0xx)/plan(0xx)：计划文档的状态流转）对读者没有信息量，剔掉。
const GROUPS = [
  { title: "新功能", match: /^feat\b/i },
  { title: "修复", match: /^(fix|revert)\b/i },
  { title: "重构与内部改动", match: /^(refactor|perf|test|build|ci)\b/i },
  { title: "其他", match: /./ },
];
const PLAN_COMMIT = /^(chore|plan|docs)\(\d{3}\)/;

/** 分组后 type 前缀就是冗余的，剥掉；scope 提成粗体前缀（`feat(web): x` → `**web**：x`）。 */
function present(subject) {
  const parsed = subject.match(/^\w+(?:\(([^)]+)\))?!?:\s*(.+)$/);
  if (!parsed) return subject; // Revert "…" 等非 conventional 形态原样保留
  const [, scope, text] = parsed;
  return scope ? `**${scope}**：${text}` : text;
}

/** commit subject 列表 → 分组后的 markdown 行（纯函数，自检对着它跑）。 */
function changelog(subjects) {
  const buckets = GROUPS.map(() => []);
  for (const subject of subjects) {
    if (PLAN_COMMIT.test(subject)) continue;
    buckets[GROUPS.findIndex((g) => g.match.test(subject))].push(present(subject));
  }
  const lines = [];
  for (const [i, group] of GROUPS.entries()) {
    if (!buckets[i].length) continue;
    lines.push(`### ${group.title}`, "", ...buckets[i].map((entry) => `- ${entry}`), "");
  }
  return lines.length ? lines : ["_本版无代码变更（仅计划文档或发版收尾）。_", ""];
}

function build(version, prevArg) {
  // 上一个 tag：优先用参数；否则取本 tag 之前最近的一个（--merged 保证在同一条历史上）
  let prev = prevArg;
  if (!prev) {
    const tags = git("tag", "--list", "v*", "--sort=-v:refname", "--merged", version)
      .split("\n")
      .filter((t) => t && t !== version);
    prev = tags[0];
  }
  // 首版没有 prev：整条历史都算这一版的内容
  const range = prev ? `${prev}..${version}` : version;
  const subjects = git("log", range, "--no-merges", "--pretty=format:%s").split("\n").filter(Boolean);
  const lines = changelog(subjects);

  // 升级须知：daemon 自动升级不用管，CLI 只有版本变了才需要用户动手——所以拿上一版的
  // package.json 比一比，没变就不提，避免每版都印一句无效指令。
  // 两端都从 tag 读（而非工作区），这样回填历史版本的 note 也拿到当时的版本号。
  const cliAt = (ref) => {
    try {
      return JSON.parse(git("show", `${ref}:packages/cli/package.json`)).version;
    } catch {
      return null; // 那个版本还没有这个文件
    }
  };
  const cliVersion = cliAt(version) ?? JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;
  const prevCli = prev ? cliAt(prev) : null;

  lines.push("## 升级", "");
  lines.push("- **daemon**：在线设备由中心自动推送升级（worker 验签后热切换），无需手动操作。");
  lines.push(
    cliVersion === prevCli
      ? `- **cofluxd CLI**：本版无变化（\`${cliVersion}\`）。`
      : `- **cofluxd CLI**：\`npm i -g cofluxd@latest\`（\`${prevCli ?? "—"}\` → \`${cliVersion}\`）。`,
  );
  lines.push("");
  lines.push(
    prev
      ? `**Full Changelog**: https://github.com/${repo}/compare/${prev}...${version}`
      : `**Full Changelog**: https://github.com/${repo}/commits/${version}`,
  );
  return lines.join("\n");
}

async function selfCheck() {
  const { strict: assert } = await import("node:assert");
  assert.equal(present("feat(web): 冷启动遮罩"), "**web**：冷启动遮罩");
  assert.equal(present("chore: bump cofluxd"), "bump cofluxd");
  assert.equal(present("fix(daemon)!: 破坏性修复"), "**daemon**：破坏性修复");
  // 非 conventional 形态（revert 自动生成的标题）必须原样保留，不能被吞成空行
  assert.equal(present('Revert "fix(client): 静默死亡自愈"'), 'Revert "fix(client): 静默死亡自愈"');

  const md = changelog([
    "feat(web): A",
    "fix(client): B",
    'Revert "fix(client): B"',
    "test(client): C",
    "chore: D",
    "chore(080): 状态更新", // plan 类：剔除
    "feat(077): iOS 设备面板", // 三位数 scope 但不是 plan 类：保留
  ]).join("\n");
  assert.match(md, /### 新功能\n\n- \*\*web\*\*：A\n- \*\*077\*\*：iOS 设备面板/);
  assert.match(md, /### 修复\n\n- \*\*client\*\*：B\n- Revert /); // revert 归修复，不落进「其他」
  assert.match(md, /### 重构与内部改动\n\n- \*\*client\*\*：C/);
  assert.match(md, /### 其他\n\n- D/);
  assert.ok(!md.includes("状态更新"), "plan 类 commit 必须被剔除");
  assert.equal(changelog(["chore(080): 只有计划流转"])[0], "_本版无代码变更（仅计划文档或发版收尾）。_");
  console.log("release-notes self-check ok");
}

if (process.argv[2] === "--self-check") {
  await selfCheck();
} else {
  const version = process.argv[2];
  if (!version || !repo) {
    console.error("用法: GITHUB_REPOSITORY=owner/repo node scripts/release-notes.mjs <version> [prevTag]");
    process.exit(1);
  }
  console.log(build(version, process.argv[3]));
}
