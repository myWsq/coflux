/** 从当前 Web 使用的 Lucide 导出原生矢量资源；不另画一套相似图标。 */
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(root, "apps/web/node_modules/lucide-react");
const assets = resolve(root, "apps/macos/Sources/Assets.xcassets");
const icons = ["refresh-cw", "circle-alert", "circle-x", "trash-2", "radio", "external-link", "router", "zap", "bot", "unplug", "git-branch", "folder", "folder-open", "folder-git-2", "folder-plus", "lock-keyhole", "monitor", "monitor-up", "square-terminal", "plus", "x", "cloud", "circle", "arrow-up", "network", "file-diff", "chevron-down", "chevron-right"];
icons.push("message-square", "loader-circle", "package", "cog", "info");
mkdirSync(assets, { recursive: true });
writeFileSync(resolve(assets, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2));
for (const name of icons) {
  const { __iconNode } = await import(pathToFileURL(resolve(packageRoot, `dist/esm/icons/${name}.mjs`)));
  const xml = __iconNode.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== "key").map(([key, value]) => `${key}="${value}"`).join(" ")}/>`).join("");
  const folder = resolve(assets, `${name}.imageset`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${xml}</svg>\n`);
  writeFileSync(resolve(folder, "Contents.json"), JSON.stringify({ images: [{ filename: `${name}.svg`, idiom: "universal" }], info: { author: "xcode", version: 1 }, properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" } }, null, 2));
}
copyFileSync(resolve(packageRoot, "LICENSE"), resolve(root, "apps/macos/LUCIDE-LICENSE"));
