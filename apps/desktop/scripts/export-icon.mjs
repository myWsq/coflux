/**
 * 从 Icon Composer 文档（build/AppIcon.icon，plan 103 自 apps/macos 抢救）导出 electron-builder 用的
 * build/icon.png（1024×1024，macOS 圆角矩形模板：824 边长、居中、圆角 ≈ 185）。
 *
 * 只在 macOS 上可跑：用 Quick Look（qlmanage）栅格化 SVG。图标源改动后重跑一次并提交产物；
 * electron-builder 自己把 png 转成 icns，不需要 iconutil。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname);
const iconDir = resolve(here, "../build/AppIcon.icon");
const output = resolve(here, "../build/icon.png");

const document = JSON.parse(readFileSync(join(iconDir, "icon.json"), "utf8"));
// fill-specializations[0] 是 light 外观底色："srgb:r,g,b,a"（0-1）
const fill = document["fill-specializations"]?.[0]?.value?.["automatic-gradient"] ?? "srgb:0.102,0.106,0.118,1";
const [r, g, b] = fill.replace(/^srgb:/, "").split(",").map((value) => Math.round(Number(value) * 255));
const background = `rgb(${r},${g},${b})`;
const layer = document.groups?.[0]?.layers?.[0]?.["image-name"] ?? "glyph.svg";
const glyph = readFileSync(join(iconDir, "Assets", layer), "utf8");
const glyphInner = glyph.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const SIZE = 1024;
const INNER = 824;
const OFFSET = (SIZE - INNER) / 2;
const RADIUS = 185;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect x="${OFFSET}" y="${OFFSET}" width="${INNER}" height="${INNER}" rx="${RADIUS}" fill="${background}"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${INNER / SIZE})">${glyphInner}</g>
</svg>
`;

const work = mkdtempSync(join(tmpdir(), "coflux-icon-"));
try {
  const svgPath = join(work, "icon.svg");
  writeFileSync(svgPath, svg);
  execFileSync("qlmanage", ["-t", "-s", String(SIZE), "-o", work, svgPath], { stdio: "ignore" });
  copyFileSync(join(work, "icon.svg.png"), output);
  console.log(`已导出 ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
