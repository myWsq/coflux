/**
 * 从 Icon Composer 文档（build/AppIcon.icon，自 apps/macos 抢救）编译 App 图标（plan 103）：
 *
 * - build/Assets.car ：分层图标，macOS 26 按 Liquid Glass 实时渲染（Clear/Tinted 外观也对），
 *   经 electron-builder 的 extraResources 放进 Contents/Resources，Info.plist 由 extendInfo 写
 *   CFBundleIconName=AppIcon 指向它。这是唯一真正被用到的图标。
 * - build/AppIcon.icns：actool 顺带生成的扁平版，只因为 electron-builder 必须有一个 mac.icon 文件才保留。
 *   app 只支持 macOS 26+（minimumSystemVersion），没有向下兼容的用途。
 *
 * 两份产物都提交进仓库：CI runner 的 Xcode 不一定能编译 .icon（需要 Xcode 26），本机跑一次即可。
 * 改图标：用 Icon Composer 打开 build/AppIcon.icon，改完重跑 `pnpm -C apps/desktop icon` 并提交产物。
 * 只在 macOS + Xcode 26 上可跑。
 *
 * 为什么不用一张带透明边距的 PNG：macOS 26 会把非满幅的旧式图标放到白色底板上，Dock 里看起来像
 * 一圈粗白边（2026-09-11 首发实测）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname);
const iconDocument = resolve(here, "../build/AppIcon.icon");
const buildDir = resolve(here, "../build");

const work = mkdtempSync(join(tmpdir(), "coflux-icon-"));
try {
  const out = join(work, "out");
  mkdirSync(out);
  execFileSync(
    "xcrun",
    [
      "actool",
      iconDocument,
      "--compile",
      out,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      "26.0",
      "--app-icon",
      "AppIcon",
      "--output-partial-info-plist",
      join(out, "partial.plist"),
      "--output-format",
      "human-readable-text",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  for (const name of ["Assets.car", "AppIcon.icns"]) {
    const source = join(out, name);
    statSync(source);
    copyFileSync(source, join(buildDir, name));
    console.log(`已导出 ${join(buildDir, name)}（${statSync(source).size} 字节）`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
