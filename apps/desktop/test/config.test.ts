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
  // 占位 URL 由 CI 覆盖；不许把真实域名写死在仓库配置里（R2 域名属于用户提供的变量）
  assert.match(config.publish.url, /\.invalid\//);
});

type Workflow = {
  on: { push: { tags: string[] } };
  permissions: { contents: string };
  jobs: Record<string, { environment?: string; permissions?: { contents?: string }; steps: { name?: string; env?: Record<string, string>; run?: string; uses?: string }[] }>;
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
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "DESKTOP_UPDATE_URL",
  ];
  for (const name of required) {
    assert.ok(guard.env?.[name] !== undefined, `齐全性检查未引用 ${name}`);
    assert.match(guard.run, new RegExp(`\\b${name}\\b`));
  }

  const pack = build.steps.find((step) => step.run?.includes("electron-builder --mac"));
  assert.ok(pack?.run, "缺少 electron-builder 打包步骤");
  assert.match(pack.run, /--publish never/); // 上传由独立步骤做，builder 不直接发布
  assert.match(pack.run, /--config\.publish\.url=/);
  assert.equal(pack.env?.CSC_LINK, "${{ secrets.MACOS_CERT_P12 }}");
  assert.equal(pack.env?.APPLE_API_KEY_ID, "${{ secrets.NOTARY_KEY_ID }}");
  assert.equal(pack.env?.APPLE_API_ISSUER, "${{ secrets.NOTARY_ISSUER_ID }}");

  const upload = build.steps.find((step) => step.name?.includes("R2"));
  assert.ok(upload?.run, "缺少 R2 上传步骤");
  const manifestIndex = upload.run.indexOf("latest-mac.yml");
  const artifactsIndex = upload.run.indexOf("*.dmg *.zip");
  assert.ok(artifactsIndex >= 0 && manifestIndex > artifactsIndex, "latest-mac.yml 必须在安装包之后上传");
  assert.match(upload.run, /--endpoint-url/);

  const release = workflow.jobs.release;
  assert.equal(release.permissions?.contents, "write");
  assert.ok(release.steps.some((step) => step.uses?.startsWith("softprops/action-gh-release@")));
});

test("ci.yml 带 desktop 质量门", () => {
  const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /pnpm -C apps\/desktop typecheck && pnpm -C apps\/desktop test && pnpm -C apps\/desktop build/);
});
