import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.COFLUX_GHOSTTY_SDK ?? "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk";
const nodeHeaders = process.env.COFLUX_NODE_HEADERS ?? join(homedir(), "Library/Caches/node-gyp/26.3.0/include/node");
if (!existsSync(join(nodeHeaders, "node_api.h"))) {
  throw new Error("缺少 Node-API 头文件：运行 npx --yes node-gyp@11 install --target=26.3.0，或指定 COFLUX_NODE_HEADERS");
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("swift", ["build", "--disable-sandbox", "-c", "release", "--arch", "arm64", "-Xswiftc", "-enable-testing"]);
mkdirSync(join(root, "build"), { recursive: true });
const common = ["clang++", "-std=c++17", "-arch", "arm64", "-isysroot", sdk, "-mmacosx-version-min=26.0", "-framework", "AppKit", "-L.build/arm64-apple-macosx/release", "-lCofluxGhostty"];
run("xcrun", [...common, "smoke.mm", "-Wl,-rpath,@executable_path/../.build/arm64-apple-macosx/release", "-o", "build/ghostty-smoke"]);
run("xcrun", [...common, "-bundle", "-undefined", "dynamic_lookup", "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=coflux_ghostty", `-I${nodeHeaders}`, "addon.mm", "-Wl,-rpath,@loader_path/../.build/arm64-apple-macosx/release", "-o", "build/coflux_ghostty.node"]);
