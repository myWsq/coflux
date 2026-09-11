// 显式 pack:ghostty 专用；默认 pack/dist/release 配置完全不加入原生产物。
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parse } = require("yaml");
const base = parse(readFileSync(join(__dirname, "../electron-builder.yml"), "utf8"));
const unpacked = "Contents/Resources/app.asar.unpacked/native/ghostty/build";
module.exports = {
  ...base,
  files: [...base.files, "native/ghostty/build/coflux_ghostty.node", "native/ghostty/build/libCofluxGhostty.dylib"],
  asarUnpack: ["native/ghostty/build/*.node", "native/ghostty/build/*.dylib"],
  mac: {
    ...base.mac,
    ...(process.env.COFLUX_GHOSTTY_ADHOC === "1" ? { identity: "-", notarize: false } : {}),
    extraResources: [...base.mac.extraResources, {
      from: "native/ghostty/build/GhosttyKit_GhosttyTerminal.bundle",
      to: "ghostty/GhosttyKit_GhosttyTerminal.bundle",
    }],
    binaries: [...base.mac.binaries, `${unpacked}/coflux_ghostty.node`, `${unpacked}/libCofluxGhostty.dylib`],
  },
};
