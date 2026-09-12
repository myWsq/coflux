#!/usr/bin/env node
// 公开发布说明必须人工编写为英文并与版本一起提交；不再把中文 commit 原样拼进 Release。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictSemver } from "./npm-publish-guard.mjs";

export function validateReleaseNotes(version, text) {
  parseStrictSemver(version);
  if (!text.startsWith(`# Coflux ${version}\n`)) throw new Error(`Release notes must begin with # Coflux ${version}`);
  if (text.trim().length < 200) throw new Error("Release notes must describe the release, installation, and upgrade impact");
  if (/\p{Script=Han}/u.test(text)) throw new Error("Public release notes must be written in English");
  if (/\b(?:TODO|TBD)\b/.test(text)) throw new Error("Release notes contain unfinished placeholders");
  return text.trim();
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
function build(tag, previous, repository) {
  if (!/^v/.test(tag)) throw new Error("Expected a vX.Y.Z release tag");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  const version = tag.slice(1);
  parseStrictSemver(version);
  const body = validateReleaseNotes(version, git("show", `${tag}:docs/releases/${version}.md`));
  const tags = git("tag", "--list", "v*", "--sort=-v:refname", "--merged", tag).split("\n").filter(value => value && value !== tag);
  const prev = previous || tags[0];
  const url = prev ? `https://github.com/${repository}/compare/${prev}...${tag}` : `https://github.com/${repository}/commits/${tag}`;
  return `${body}\n\n**Full changelog:** ${url}\n`;
}

async function selfCheck() {
  const { strict: assert } = await import("node:assert");
  const notes = "# Coflux 1.0.0\n\n" + "Install the app and review the upgrade instructions. ".repeat(5);
  assert.equal(validateReleaseNotes("1.0.0", notes), notes.trim());
  assert.throws(() => validateReleaseNotes("1.0.1", notes), /must begin/);
  assert.throws(() => validateReleaseNotes("1.0.0", notes + "中文"), /English/);
  assert.throws(() => validateReleaseNotes("1.0.0", notes + "TODO"), /placeholders/);
  assert.throws(() => validateReleaseNotes("1.0.0", "# Coflux 1.0.0\n"), /describe/);
  console.log("release-notes self-check ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "--self-check") await selfCheck();
    else if (process.argv[2] === "--check") {
      const version = JSON.parse(readFileSync("package.json", "utf8")).version;
      validateReleaseNotes(version, readFileSync(`docs/releases/${version}.md`, "utf8"));
      console.log(`English release notes ready: ${version}`);
    } else console.log(build(process.argv[2] ?? "", process.argv[3], process.env.GITHUB_REPOSITORY));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
