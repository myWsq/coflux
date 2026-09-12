import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseSupervisorVersion } from "./daemon-files";
import { CLAUDE_PLUGIN_MANIFEST, CLAUDE_PLUGIN_RESOURCE_DIR, DAEMON_BINARIES, DAEMON_RESOURCE_DIR, DAEMON_VERSION_FILE } from "./daemon-paths";

/**
 * 内置 daemon 三件的定位（plan 113）。打包版在 `<resourcesPath>/daemon/`（electron-builder extraResources），
 * 未打包 dev 实例在 `<appPath>/build/daemon/`（与 scripts/stage-daemon.mjs 的落位目录同源）。
 * 三件缺任一即视为「本构建不带 daemon」——状态对象里 bundled=false，不崩。只读 fs，无 Electron 依赖。
 */
export type DaemonBundle = {
  dir: string;
  /** VERSION sidecar 原文（trim 后）；缺失 / 空 → null，与 dev 同样按「解析不了」处理 */
  version: string | null;
};

export function resolveDaemonBundleDir(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged ? join(input.resourcesPath, DAEMON_RESOURCE_DIR) : join(input.appPath, "build", DAEMON_RESOURCE_DIR);
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 内置 coflux 插件目录（plan 115）：资源目录下的 `claude-plugin/`，带清单才算数。
 * 与三件的存在性无关——插件只是一堆普通文件，本构建有没有 daemon 二进制不影响它。
 * 返回 null（没跑过 stage 脚本的 dev 实例、旧构建）时 plist 不写 COFLUX_CLAUDE_PLUGIN_DIR，
 * coflux 终端里的 claude 与今天一致，这同时就是逃生口。
 */
export function locateClaudePluginDir(bundleDir: string): string | null {
  const dir = join(bundleDir, CLAUDE_PLUGIN_RESOURCE_DIR);
  return isNonEmptyFile(join(dir, ...CLAUDE_PLUGIN_MANIFEST)) ? dir : null;
}

export function locateDaemonBundle(dir: string): DaemonBundle | null {
  if (!DAEMON_BINARIES.every((name) => isNonEmptyFile(join(dir, name)))) return null;
  let version: string | null = null;
  try {
    version = parseSupervisorVersion(readFileSync(join(dir, DAEMON_VERSION_FILE), "utf8"));
  } catch {
    version = null;
  }
  return { dir, version };
}
