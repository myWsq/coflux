import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 固定 revision 的 SwiftPM Bundle.module 默认找 .app 根，动态宿主应找 Contents/Resources。 */
export function patchResources(root) {
  const path = join(root, ".build/checkouts/libghostty-spm/Sources/GhosttyTerminal/Configuration/GhosttyRuntimeResources.swift");
  const source = readFileSync(path, "utf8");
  if (source.includes("private static var cofluxResourceBundle")) return;
  if (source.split("Bundle.module.url").length !== 3 || !source.includes("public enum GhosttyRuntimeResources {")) throw new Error("锁定包资源入口发生变化，停止打补丁");
  const replacement = `public enum GhosttyRuntimeResources {
    // Coflux 动态宿主：打包资源必须来自实际 app，不能依赖编译机绝对路径。
    private static var cofluxResourceBundle: Bundle {
        if let resources = Bundle.main.resourceURL,
           let packaged = Bundle(url: resources.appendingPathComponent("ghostty/GhosttyKit_GhosttyTerminal.bundle")) {
            return packaged
        }
        return Bundle.module
    }`;
  writeFileSync(path, source.replace("public enum GhosttyRuntimeResources {", replacement).replaceAll("Bundle.module.url", "cofluxResourceBundle.url"));
}
