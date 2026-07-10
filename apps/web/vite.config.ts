import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 后端中心服务器地址（仅 dev server 内部代理用，不暴露给浏览器）
const BACKEND = process.env.COFLUX_BACKEND ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});
