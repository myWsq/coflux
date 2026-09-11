import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// 渲染层就在 src/renderer（plan 106）：index.html / public / 组件全在这一份里，插件链
// （react compiler / tailwind / `@` alias / build-id 注入）也只在这里定义。
const RENDERER_ROOT = resolve(__dirname, "src/renderer");

// 构建版本（plan 033）：生产构建取 git short SHA，随 ClientAuth 上报只作标识（桌面按控制面协议版本
// 准入，plan 105）；dev 固定 "dev"。
function resolveBuildId(command: "build" | "serve"): string {
  if (command !== "build") return "dev";
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

/**
 * electron-vite 的 renderer 预设会在生产构建把 base 强制成 "./"（为 file:// 加载准备）。本项目经
 * standard scheme `coflux-app://app/` 从根提供渲染层，base 必须保持 "/"：public 资源的绝对路径、
 * 动态 chunk（WebGL addon 等）的解析都按根解析。post 钩子晚于预设生效。
 */
function absoluteBase(): Plugin {
  return {
    name: "coflux-desktop-absolute-base",
    enforce: "post",
    config: () => ({ base: "/" }),
  };
}

export default defineConfig(({ command }) => {
  const buildId = resolveBuildId(command === "build" ? "build" : "serve");
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: resolve(__dirname, "src/preload/index.ts"),
          // sandbox 渲染进程只接受 CommonJS preload（Electron 的 ESM preload 仅限非 sandbox）；
          // package.json 是 type: module，扩展名显式用 .cjs 避免被当作 ESM。
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: RENDERER_ROOT,
      define: {
        __COFLUX_BUILD_ID__: JSON.stringify(buildId),
      },
      plugins: [
        react({
          babel: {
            plugins: [["babel-plugin-react-compiler", {}]],
          },
        }),
        tailwindcss(),
        absoluteBase(),
      ],
      resolve: {
        alias: {
          "@": RENDERER_ROOT,
        },
      },
      build: {
        outDir: resolve(__dirname, "out/renderer"),
        rollupOptions: {
          input: resolve(RENDERER_ROOT, "index.html"),
        },
      },
      server: {
        // 桌面 dev 直连中心 8787（地址由主进程给出），不走 vite 代理。
        port: 5274,
        strictPort: true,
      },
    },
  };
});
