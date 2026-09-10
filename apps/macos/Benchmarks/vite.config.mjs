import { fileURLToPath } from "node:url";
export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@xterm-css": fileURLToPath(new URL("../../web/node_modules/@xterm/xterm/css/xterm.css", import.meta.url)), "@xterm/xterm": fileURLToPath(new URL("../../web/node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 15276, strictPort: true },
};
