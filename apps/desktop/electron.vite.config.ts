import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

import { createWebViteConfig } from "../web/vite.config";

// 渲染层 = apps/web 原样（plan 103）：root 直接指向 apps/web，index.html / public / src 都是浏览器那份，
// 插件链也从 apps/web/vite.config.ts 拿，这里不复制任何组件、样式或配置。
const WEB_ROOT = resolve(__dirname, "../web");

/**
 * electron-vite 的 renderer 预设会在生产构建把 base 强制成 "./"（为 file:// 加载准备）。本项目经
 * standard scheme `coflux-app://app/` 从根提供渲染层，base 必须与 apps/web 一致保持 "/"：
 * public 资源的绝对路径、动态 chunk（WebGL addon 等）的解析才与浏览器零差异。post 钩子晚于预设生效。
 */
function absoluteBase(): Plugin {
  return {
    name: "coflux-desktop-absolute-base",
    enforce: "post",
    config: () => ({ base: "/" }),
  };
}

export default defineConfig(({ command }) => {
  const web = createWebViteConfig(command === "build" ? "build" : "serve", WEB_ROOT);
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
      root: WEB_ROOT,
      define: web.define,
      plugins: [...web.plugins, absoluteBase()],
      resolve: web.resolve,
      build: {
        outDir: resolve(__dirname, "out/renderer"),
        rollupOptions: {
          input: resolve(WEB_ROOT, "index.html"),
        },
      },
      server: {
        // 与 apps/web 的 5273 错开：两者可同时开发；桌面 dev 直连中心 8787，不走 vite 代理。
        port: 5274,
        strictPort: true,
      },
    },
  };
});
