import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 后端中心服务器地址（仅 dev server 内部代理用，不暴露给浏览器）
const BACKEND = process.env.COFLUX_BACKEND ?? "http://localhost:8787";

// 构建版本（plan 033）：生产构建取 git short SHA，随 ClientAuth 上报供 server 做版本准入；
// vite dev 固定 "dev"（server 总放行，本机联调不受影响）。
function resolveBuildId(command: string): string {
  if (command !== "build") return "dev";
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __COFLUX_BUILD_ID__: JSON.stringify(resolveBuildId(command)),
  },
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    host: true, // 监听 0.0.0.0，等价 --host，可局域网访问
    port: 5273,
    // 浏览器只连前端同源，由 dev server 把 WS 代理到后端
    proxy: {
      "/client": { target: BACKEND, ws: true, changeOrigin: true },
      "/health": { target: BACKEND, changeOrigin: true },
    },
  },
}));
