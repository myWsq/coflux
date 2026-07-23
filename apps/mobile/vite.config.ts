import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
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

// 构建产物自举（2026-07-23 修订）：dist/build-id.txt 与 define 注入的值恒等，server 直接
// 读这份文件做版本准入（COFLUX_BUILD_ID_FILE）——部署只需"拉代码+构建"，不必手动对齐 env。
function writeBuildIdFile(buildId: string): Plugin {
  return {
    name: "coflux-build-id-file",
    writeBundle(options) {
      writeFileSync(join(options.dir ?? "dist", "build-id.txt"), buildId);
    },
  };
}

export default defineConfig(({ command }) => {
  const buildId = resolveBuildId(command);
  return {
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
      writeBuildIdFile(buildId),
    ],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
    server: {
      host: true, // 监听 0.0.0.0，等价 --host，可局域网访问（手机真机联调）
      port: 5373, // 5173 被其它项目占用、5273 是桌面 web dev，mobile 独立端口
      proxy: {
        "/client": { target: BACKEND, ws: true, changeOrigin: true },
        "/health": { target: BACKEND, changeOrigin: true },
      },
    },
  };
});
