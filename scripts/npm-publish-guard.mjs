#!/usr/bin/env node
// npm latest 发布门：严格解析 package/registry SemVer；registry latest 结构有效时保留已存在版本的
// 幂等语义，只允许 precedence 严格高于当前 dist-tags.latest 的新稳定版进入 publish。
//
//   分类: node scripts/npm-publish-guard.mjs --classify <package-version>
//   裁决: node scripts/npm-publish-guard.mjs <package-version> <versions.json> <dist-tags.json>
//   自检: node scripts/npm-publish-guard.mjs --self-check
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 严格 SemVer：数字 prerelease identifier 不允许前导 0，build metadata 不参与 precedence。 */
export function parseStrictSemver(value, label = "version") {
  const match = typeof value === "string" ? STRICT_SEMVER.exec(value) : null;
  if (!match) throw new Error(`${label} 不是严格 SemVer: ${JSON.stringify(value)}`);
  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => {
        if (/^\d+$/.test(identifier)) {
          if (identifier.length > 1 && identifier.startsWith("0")) {
            throw new Error(`${label} 的数字 prerelease 标识符含前导 0: ${JSON.stringify(value)}`);
          }
          return { numeric: true, value: BigInt(identifier) };
        }
        return { numeric: false, value: identifier };
      })
    : [];
  return {
    raw: value,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

/** 返回 -1/0/1；build metadata 按 SemVer 规则不影响 precedence。 */
export function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const common = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < common; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a.numeric && b.numeric) {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    } else if (a.numeric !== b.numeric) {
      return a.numeric ? -1 : 1;
    } else {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    }
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/**
 * registry 响应由 workflow 两次 `npm view --json` 产生；任一网络命令或 JSON 解析失败都在此前/此处 fail closed。
 */
export function decideNpmPublish(packageVersion, versions, distTags) {
  const candidate = parseStrictSemver(packageVersion, "package.json version");
  if (candidate.prerelease.length > 0) return { action: "skip-prerelease" };
  if (!Array.isArray(versions) || !versions.every((version) => typeof version === "string")) {
    throw new Error("npm registry versions 必须是字符串数组");
  }
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error("npm registry dist-tags 必须是对象");
  }
  const latestVersion = distTags.latest;
  const latest = parseStrictSemver(latestVersion, "npm dist-tags.latest");
  if (!versions.includes(latestVersion)) {
    throw new Error(`npm dist-tags.latest ${JSON.stringify(latestVersion)} 不在 registry versions 中`);
  }
  if (versions.includes(packageVersion)) return { action: "skip-existing" };
  if (compareSemver(candidate, latest) <= 0) {
    throw new Error(
      `未发布版本 ${packageVersion} 不高于 npm latest ${latestVersion}，拒绝回退 latest`,
    );
  }
  return { action: "publish", latestVersion };
}

async function selfCheck() {
  const { strict: assert } = await import("node:assert");
  const parse = (value) => parseStrictSemver(value);
  assert.equal(compareSemver(parse("1.2.4"), parse("1.2.3")), 1);
  assert.equal(compareSemver(parse("1.2.3-rc.2"), parse("1.2.3-rc.10")), -1);
  assert.equal(compareSemver(parse("1.2.3"), parse("1.2.3-rc.10")), 1);
  assert.equal(compareSemver(parse("1.2.3+build.2"), parse("1.2.3+build.1")), 0);
  assert.throws(() => parse("1.2.3-01"), /前导 0/);
  assert.deepEqual(decideNpmPublish("1.2.3", ["1.2.3", "2.0.0"], { latest: "2.0.0" }), {
    action: "skip-existing",
  });
  assert.deepEqual(decideNpmPublish("1.2.4", ["1.2.3"], { latest: "1.2.3" }), {
    action: "publish",
    latestVersion: "1.2.3",
  });
  assert.deepEqual(decideNpmPublish("1.3.0-rc.1", ["1.2.3"], { latest: "1.2.3" }), {
    action: "skip-prerelease",
  });
  assert.throws(
    () => decideNpmPublish("1.2.3+rebuild.1", ["1.2.3"], { latest: "1.2.3" }),
    /拒绝回退 latest/,
  );
  assert.throws(() => decideNpmPublish("1.2.4", ["1.2.3"], { latest: "latest" }), /严格 SemVer/);
  assert.throws(() => decideNpmPublish("1.2.4", ["1.2.2"], { latest: "1.2.3" }), /versions 中/);
  console.log("npm-publish-guard self-check ok");
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--self-check") {
    await selfCheck();
    return;
  }
  if (mode === "--classify") {
    const parsed = parseStrictSemver(args[0], "package.json version");
    process.stdout.write(parsed.prerelease.length > 0 ? "prerelease" : "stable");
    return;
  }
  if (!mode || args.length !== 2) {
    throw new Error(
      "用法: node scripts/npm-publish-guard.mjs <package-version> <versions.json> <dist-tags.json>",
    );
  }
  const versions = JSON.parse(readFileSync(args[0], "utf8"));
  const distTags = JSON.parse(readFileSync(args[1], "utf8"));
  process.stdout.write(decideNpmPublish(mode, versions, distTags).action);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
