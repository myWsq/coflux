import { once } from "node:events";
const mode = process.argv[2] ?? "grapheme";
const columns = Math.max(8, process.stdout.columns ?? Number(process.env.COLUMNS ?? 80));
const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, "drain"); };
await write("\x1b[2J\x1b[H");
if (mode === "grapheme") {
  await write("G1 家庭: 👨‍👩‍👧\r\nG1 旗帜: 🇯🇵\r\nG1 肤色: 👋🏽\r\nG1 组合: e\u0301\r\n");
  await write("X".repeat(columns - 1) + "界Z\r\nCOFLUX_FIXTURE_READY\r\n");
} else if (mode === "boundaries") {
  for (const byte of Buffer.from("半截UTF8 👋🏽")) { await write(Buffer.from([byte])); await new Promise((resolve) => setTimeout(resolve, 15)); }
  await write("\x1b["); await new Promise((resolve) => setTimeout(resolve, 200));
  await write("32mCSI_OK\x1b[0m\r\n\x1b[?1049hALT_SCREEN\r\n");
  process.stdout.on("resize", () => { void write(`\x1b[2J\x1b[H${"X".repeat(Math.max(1, process.stdout.columns - 1))}界Z\r\n`); });
} else if (mode === "performance") {
  // 64 KiB/s，持续输出时 raw stdin 的 PING 得到显式 PONG，便于两种终端用同一方法采样。
  const line = "性能负载 0123456789 abcdefghijklmnopqrstuvwxyz 👋🏽\r\n";
  const payload = Buffer.from(line.repeat(Math.ceil(4096 / Buffer.byteLength(line))));
  let writing = false;
  setInterval(async () => { if (writing) return; writing = true; try { await write(payload); } finally { writing = false; } }, 63);
} else { throw new Error("mode: grapheme | boundaries | performance"); }
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = "";
process.stdin.on("data", (data) => {
  if (data.includes(3)) { process.stdout.write("\x1b[?1049l\x1b[0m\r\n"); process.exit(0); }
  input = (input + data.toString()).slice(-4096);
  input = input.replace(/COFLUX_PING_([a-zA-Z0-9-]+)\n/g, (_match, id) => { process.stdout.write(`\r\nCOFLUX_PONG_${id}\r\n`); return ""; });
});
process.stdin.resume();
