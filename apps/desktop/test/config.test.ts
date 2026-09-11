import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import { DAEMON_BINARIES, DAEMON_RESOURCE_DIR, DAEMON_VERSION_FILE } from "../src/main/daemon-paths";

// 发布配置（electron-builder.yml）与发布 workflow 能被解析且守住 plan 103 的硬约束。
const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");

type Builder = {
  appId: string;
  asar: boolean;
  files: string[];
  electronFuses: Record<string, boolean>;
  mac: {
    target: { target: string; arch: string[] }[];
    hardenedRuntime: boolean;
    entitlements: string;
    entitlementsInherit: string;
    notarize: boolean;
    icon: string;
    minimumSystemVersion: string;
    extendInfo?: Record<string, string>;
    extraResources?: { from: string; to: string }[];
    binaries?: string[];
  };
  publish: { provider: string; url: string; channel: string };
};

test("electron-builder.yml：签名公证、Fuses、arm64 dmg+zip、generic 更新源", () => {
  const config = parse(readFileSync(resolve(desktopRoot, "electron-builder.yml"), "utf8")) as Builder;
  assert.equal(config.asar, true);
  assert.ok(config.files.some((pattern) => pattern.startsWith("out/")));
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.ok(existsSync(resolve(desktopRoot, config.mac.entitlements)));
  assert.ok(existsSync(resolve(desktopRoot, config.mac.entitlementsInherit)));
  assert.ok(existsSync(resolve(desktopRoot, config.mac.icon)));
  assert.equal(config.mac.minimumSystemVersion, "26.0"); // 只支持 macOS 26+，不做向下兼容
  assert.equal(config.mac.extendInfo?.CFBundleIconName, "AppIcon"); // Liquid Glass 分层图标走 Assets.car
  assert.ok(config.mac.extraResources?.some((item) => item.to === "Assets.car" && existsSync(resolve(desktopRoot, item.from))));

  const targets = Object.fromEntries(config.mac.target.map((item) => [item.target, item.arch]));
  assert.deepEqual(targets.dmg, ["arm64"]);
  assert.deepEqual(targets.zip, ["arm64"]); // macOS 的 electron-updater 走 zip，缺它就没有自动更新

  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  });

  assert.equal(config.publish.provider, "generic");
  assert.equal(config.publish.channel, "latest");
  // 更新源是仓库 desktop-updates 分支上的清单（release workflow 推），安装包在 GitHub Release
  assert.equal(config.publish.url, "https://raw.githubusercontent.com/myWsq/coflux/desktop-updates");
});

test("electron-builder.yml：内置 daemon 三件经 extraResources 进 Resources/daemon、mac.binaries 显式签名（plan 113）", () => {
  const config = parse(readFileSync(resolve(desktopRoot, "electron-builder.yml"), "utf8")) as Builder;
  // 三件 + VERSION 只能走 extraResources（asar 完整性校验开着，files 只打 out/** 与 package.json）
  const daemon = config.mac.extraResources?.find((item) => item.to === DAEMON_RESOURCE_DIR);
  assert.ok(daemon, "extraResources 缺少内置 daemon 目录");
  assert.equal(daemon.from, "build/daemon"); // scripts/stage-daemon.mjs 的固定落位目录
  assert.ok(!config.files.some((pattern) => pattern.includes("daemon")), "内置产物不得混进 files/asar");
  // 三件都在 mac.binaries 里（Resources 下的裸可执行文件，osx-sign 默认扫不到），路径按 .app 根解析
  for (const name of DAEMON_BINARIES) {
    assert.ok(config.mac.binaries?.includes(`Contents/Resources/${DAEMON_RESOURCE_DIR}/${name}`), `mac.binaries 缺少 ${name}`);
  }
  assert.equal(config.mac.binaries?.length, DAEMON_BINARIES.length);

  // stage 脚本与主进程常量同值：脚本里的字面量不能漂
  const stage = readFileSync(resolve(desktopRoot, "scripts/stage-daemon.mjs"), "utf8");
  for (const name of DAEMON_BINARIES) assert.match(stage, new RegExp(`"${name}"`));
  assert.match(stage, new RegExp(`"${DAEMON_VERSION_FILE}"`));
  assert.match(stage, /"build", "daemon"/);
  assert.match(stage, /COFLUX_DESKTOP_DAEMON_DIR/); // 显式输入：缺失即失败，不静默出无 daemon 的包
  assert.match(stage, /process\.exit\(1\)/);

  // pack / dist 都先跑 stage 脚本
  const pkg = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.pack, /^node scripts\/stage-daemon\.mjs && /);
  assert.match(pkg.scripts.dist, /^node scripts\/stage-daemon\.mjs && /);
  assert.equal(pkg.scripts["stage-daemon"], "node scripts/stage-daemon.mjs");
});

type Workflow = {
  on: { push: { tags: string[] } };
  permissions: { contents: string };
  jobs: Record<
    string,
    {
      needs?: string | string[];
      environment?: string;
      permissions?: { contents?: string };
      steps: { name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, string> }[];
    }
  >;
};

test("desktop-release.yml：并行 daemon job 同 SHA cargo build 三件、版本戳 v0.0.0-desktop.*、打包 job 落位并校验签名（plan 113）", () => {
  const workflow = parse(readFileSync(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8")) as Workflow;
  const daemon = workflow.jobs.daemon;
  assert.ok(daemon, "缺少 daemon job");
  assert.equal(daemon.environment, undefined, "daemon job 不需要签名 secret，不得挂 release-signing");
  assert.equal(daemon.needs, "metadata");
  const cargo = daemon.steps.find((step) => step.run?.includes("cargo build"));
  assert.ok(cargo?.run, "缺少 cargo build 步骤");
  assert.match(cargo.run, /--release --target aarch64-apple-darwin/);
  for (const pkg of ["coflux-supervisor", "coflux-worker", "coflux-cli"]) assert.match(cargo.run, new RegExp(`-p ${pkg}\\b`));
  assert.equal(cargo.env?.RUSTFLAGS, "-D warnings");
  // 版本戳：可解析的 prerelease SemVer、低于一切正式 v*；不能留默认 dev
  assert.equal(cargo.env?.COFLUX_RELEASE_VERSION, "v0.0.0-desktop.${{ needs.metadata.outputs.version }}");
  const stage = daemon.steps.find((step) => step.run?.includes("VERSION"));
  assert.ok(stage?.run, "缺少写 VERSION 的整理步骤");
  assert.equal(stage.env?.COFLUX_RELEASE_VERSION, cargo.env?.COFLUX_RELEASE_VERSION, "VERSION 与编译期版本戳必须同值");
  for (const name of DAEMON_BINARIES) assert.match(stage.run, new RegExp(name));
  const upload = daemon.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload?.with?.name, "desktop-daemon-bundle");

  const build = workflow.jobs.build;
  assert.deepEqual(build.needs, ["metadata", "daemon"]);
  const download = build.steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "desktop-daemon-bundle");
  const stageIndex = build.steps.findIndex((step) => step.run?.includes("stage-daemon"));
  const packIndex = build.steps.findIndex((step) => step.run?.includes("electron-builder --mac"));
  assert.ok(download >= 0, "打包 job 未下载 daemon 产物");
  assert.ok(stageIndex > download && stageIndex < packIndex, "stage 脚本必须在下载之后、打包之前");
  assert.equal(build.steps[stageIndex].env?.COFLUX_DESKTOP_DAEMON_DIR, "${{ runner.temp }}/daemon-bundle");
  // 校验步骤：三件存在 + codesign --verify --strict + Developer ID + VERSION 匹配
  const verify = build.steps.find((step) => step.run?.includes("stapler validate"));
  assert.ok(verify?.run, "缺少校验步骤");
  assert.match(verify.run, new RegExp(`Contents/Resources/${DAEMON_RESOURCE_DIR}`));
  for (const name of DAEMON_BINARIES) assert.match(verify.run, new RegExp(name));
  assert.match(verify.run, /codesign --verify --strict[^\n]*\$daemon\/\$name/);
  assert.match(verify.run, /Authority=Developer ID Application/);
  assert.match(verify.run, new RegExp(`v0\\.0\\.0-desktop\\.[^\\n]*\\$daemon/${DAEMON_VERSION_FILE}`));
});

test("desktop-release.yml：desktop-v* 触发、release-signing 环境、缺 secret 明确失败、先产物后清单", () => {
  const workflow = parse(readFileSync(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8")) as Workflow;
  assert.deepEqual(workflow.on.push.tags, ["desktop-v*"]);
  // 桌面 release 绝不能成为仓库 latest（plan 113 发版时发现）：中心 daemon 自动更新只看 /releases/latest 的 manifest.json，
  // desktop-v0.1.6 抢走 latest 后 worker 热推曾整体停摆。softprops v3 的 make_latest 显式 false。
  const ghRelease = workflow.jobs.release.steps.find((step) => step.uses?.startsWith("softprops/action-gh-release@"));
  assert.equal(String(ghRelease?.with?.make_latest), "false", "桌面 release 必须 make_latest: false");
  assert.equal(workflow.permissions.contents, "read");

  const build = workflow.jobs.build;
  assert.equal(build.environment, "release-signing");
  const guard = build.steps.find((step) => step.name?.includes("必须齐全"));
  assert.ok(guard?.run, "缺少 secret 齐全性检查步骤");
  const required = [
    "MACOS_CERT_P12",
    "MACOS_CERT_PASSWORD",
    "APPLE_TEAM_ID",
    "NOTARY_API_KEY_P8",
    "NOTARY_KEY_ID",
    "NOTARY_ISSUER_ID",
  ];
  for (const name of required) {
    assert.ok(guard.env?.[name] !== undefined, `齐全性检查未引用 ${name}`);
    assert.match(guard.run, new RegExp(`\\b${name}\\b`));
  }

  const pack = build.steps.find((step) => step.run?.includes("electron-builder --mac"));
  assert.ok(pack?.run, "缺少 electron-builder 打包步骤");
  assert.match(pack.run, /--publish never/); // 发布由 release job 做，builder 不直接发布
  assert.doesNotMatch(pack.run, /--config\.publish/); // 更新源 URL 写死在 electron-builder.yml，CI 不覆盖
  // 证书不经 CSC_LINK 交给 electron-builder（它自建 keychain 在 runner 上失败）：自己导入 keychain，按 CSC_NAME 找身份
  assert.equal(pack.env?.CSC_LINK, undefined);
  // electron-builder 要求 CSC_NAME 不带「Developer ID Application:」前缀（带了直接报错，2026-09-11 实测）
  assert.match(pack.env?.CSC_NAME ?? "", /^Shuaiqi Wang \(/);
  assert.doesNotMatch(pack.env?.CSC_NAME ?? "", /Developer ID Application/);
  const packIndex = build.steps.indexOf(pack);
  const keychainIndex = build.steps.findIndex((step) => step.run?.includes("security import") && step.run.includes("CSC_KEYCHAIN="));
  assert.ok(keychainIndex >= 0 && keychainIndex < packIndex, "证书导入 keychain 必须在打包之前");
  assert.equal(pack.env?.APPLE_API_KEY_ID, "${{ secrets.NOTARY_KEY_ID }}");
  assert.equal(pack.env?.APPLE_API_ISSUER, "${{ secrets.NOTARY_ISSUER_ID }}");
  assert.ok(!build.steps.some((step) => step.name?.includes("R2")), "R2 上传已撤，不该再有");

  // release job：先把安装包 + blockmap 上 Release，再改写清单为绝对地址、推 desktop-updates 分支——
  // 清单永远不会先于它指向的文件出现。
  const release = workflow.jobs.release;
  assert.equal(release.permissions?.contents, "write");
  const publishIndex = release.steps.findIndex((step) => step.uses?.startsWith("softprops/action-gh-release@"));
  assert.ok(publishIndex >= 0, "缺少 GitHub Release 步骤");
  assert.match(release.steps[publishIndex].with?.files ?? "", /blockmap/); // 差分更新要 blockmap 也在 Release 上
  const rewriteIndex = release.steps.findIndex((step) => step.run?.includes("releases/download"));
  // release 说明那步也提到 desktop-updates，按「git push + 分支名」定位真正的推送步
  const pushIndex = release.steps.findIndex((step) => step.run?.includes("git push") && step.run.includes("desktop-updates"));
  assert.ok(rewriteIndex > publishIndex, "清单改写必须在 Release 上传之后");
  assert.ok(pushIndex > rewriteIndex, "推分支必须在清单改写之后");
  assert.match(release.steps[pushIndex].run ?? "", /latest-mac\.yml/);
  assert.match(release.steps[pushIndex].env?.GH_TOKEN ?? "", /github\.token/);
});

test("ci.yml 带 desktop 质量门", () => {
  const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /pnpm -C apps\/desktop typecheck && pnpm -C apps\/desktop test && pnpm -C apps\/desktop build/);
});
