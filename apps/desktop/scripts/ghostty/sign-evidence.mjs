import { spawnSync } from "node:child_process";
import { join } from "node:path";
const app = process.argv[2];
if (!app?.endsWith(".app")) throw new Error("用法：sign-evidence.mjs /path/to/Coflux.app");
const native = join(app, "Contents/Resources/app.asar.unpacked/native/ghostty/build");
const commands = [
  ["codesign", ["-dvv", "--verbose=4", app]],
  ["codesign", ["-d", "--entitlements", "-", app]],
  ...["coflux_ghostty.node", "libCofluxGhostty.dylib"].flatMap((file) => [
    ["codesign", ["-dvv", "--verbose=4", join(native, file)]],
    ["otool", ["-L", join(native, file)]],
  ]),
];
for (const [command, args] of commands) {
  console.log(JSON.stringify({ command, args }));
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
