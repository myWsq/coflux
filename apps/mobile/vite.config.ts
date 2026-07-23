import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 后端中心服务器地址（仅 dev server 内部代理用，不暴露给浏览器）
const BACKEND = process.env.COFLUX_BACKEND ?? "http://localhost:8787";

export default defineConfig({
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
    host: true, // 监听 0.0.0.0，等价 --host，可局域网访问（手机真机联调）
    port: 5373, // 5173 被其它项目占用、5273 是桌面 web dev，mobile 独立端口
    proxy: {
      "/client": { target: BACKEND, ws: true, changeOrigin: true },
      "/health": { target: BACKEND, changeOrigin: true },
    },
  },
});
