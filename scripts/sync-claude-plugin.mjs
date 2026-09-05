#!/usr/bin/env node
// Claude 插件交付目录（integrations/claude-plugin，供 myWsq/plugins 市场按 commit SHA 收集）里的 SKILL
// 与 npm 包 cofluxd 随包分发的那份是同一内容的两份拷贝：npm 那份是唯一源（Codex 用户 symlink 用），
// 插件目录不能用符号链接（市场契约禁止），所以用本脚本同步；CI 用 --check 保证两份不漂移。
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = `${root}packages/cli/skills/coflux/SKILL.md`;
const target = `${root}integrations/claude-plugin/skills/coflux/SKILL.md`;

if (process.argv.includes("--check")) {
  if (readFileSync(source, "utf8") !== readFileSync(target, "utf8")) {
    console.error("integrations/claude-plugin 里的 SKILL.md 与 packages/cli/skills 不一致：运行 node scripts/sync-claude-plugin.mjs");
    process.exit(1);
  }
  console.log("claude-plugin SKILL 与 npm 源一致");
} else {
  copyFileSync(source, target);
  console.log("已同步 SKILL.md → integrations/claude-plugin");
}
