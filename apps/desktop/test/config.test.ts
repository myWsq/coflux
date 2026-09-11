import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

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
  assert.ok(config.mac.minimumSystemVersion >= "13.0");

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

type Workflow = {
  on: { push: { tags: string[] } };
  permissions: { contents: string };
  jobs: Record<
    string,
    {
      environment?: string;
      permissions?: { contents?: string };
      steps: { name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, string> }[];
    }
  >;
};

test("desktop-release.yml：desktop-v* 触发、release-signing 环境、缺 secret 明确失败、先产物后清单", () => {
  const workflow = parse(readFileSync(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8")) as Workflow;
  assert.deepEqual(workflow.on.push.tags, ["desktop-v*"]);
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
  assert.match(pack.env?.CSC_NAME ?? "", /^Developer ID Application: /);
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
