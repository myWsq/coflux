#!/usr/bin/env node
// 一个产品版本：根 package.json 为真相源，桌面和 npm CLI 的 manifest 是交付镜像。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictSemver, compareSemver } from "./npm-publish-guard.mjs";

export const VERSION_FILES = ["package.json", "apps/desktop/package.json", "packages/cli/package.json"];
const read = (root, file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

export function checkProductVersion(root, tag) {
  const version = read(root, VERSION_FILES[0]).version;
  parseStrictSemver(version, "Coflux 产品版本");
  // 发布产物名和 npm 版本不使用 SemVer build metadata。
  if (version.includes("+")) throw new Error("产品版本不支持 build metadata");
  for (const file of VERSION_FILES.slice(1)) {
    if (read(root, file).version !== version) throw new Error(`${file} 与产品版本 ${version} 不一致，请运行 pnpm release:version <版本>`);
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`release tag ${tag} 与产品版本 v${version} 不一致`);
  return version;
}

export function setProductVersion(root, version) {
  const next = parseStrictSemver(version, "Coflux 产品版本");
  if (version.includes("+")) throw new Error("产品版本不支持 build metadata");
  // 先检查所有输入，再写文件，错误参数不得留下半套 manifest。
  const packages = VERSION_FILES.map(file => ({ file, value: read(root, file) }));
  for (const { file, value } of packages) {
    if (compareSemver(next, parseStrictSemver(value.version)) < 0) throw new Error(`${file} 不允许从 ${value.version} 降级到 ${version}`);
  }
  for (const { file, value } of packages) {
    value.version = version;
    writeFileSync(resolve(root, file), JSON.stringify(value, null, 2) + "\n");
  }
  return checkProductVersion(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, value, ...rest] = process.argv.slice(2);
  try {
    if (rest.length || (mode !== "--check" && mode !== "--set") || (mode === "--set" && !value)) throw new Error("用法: product-version.mjs --check [vX.Y.Z] | --set X.Y.Z");
    console.log(mode === "--set" ? setProductVersion(process.cwd(), value) : checkProductVersion(process.cwd(), value));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
