import assert from "node:assert/strict";
import { addon, createSurface, delay } from "./native-driver.mjs";
const surface = await createSurface();
const report = [];
try {
  addon.setAccess(surface.id, true, 1);
  const emoji = Buffer.from("👨‍👩‍👧 🇯🇵 👋🏽 e\u0301");
  for (const byte of emoji) await surface.write(Buffer.from([byte]));
  assert.ok(surface.dump().includes(emoji.toString()));
  report.push("半截 UTF-8：逐字节恢复多码点输出");
  await surface.write("\x1b["); await surface.write("2J\x1b[HCSI_OK");
  assert.ok(surface.dump().startsWith("CSI_OK"));
  report.push("半截 CSI：续块按转义序列解析");
  await surface.write("\x1b[?1049hALT_OLD\x1b[31m\x1b[");
  await surface.reset();
  await surface.write("FRESH\r\n", true);
  const replaced = surface.dump();
  assert.ok(replaced.startsWith("FRESH")); assert.ok(!replaced.includes("ALT_OLD"));
  await surface.write("\x1b[?1049l");
  assert.ok(surface.dump().startsWith("FRESH"), "replacement 不能残留旧 alt screen");
  report.push("replacement：清除半截 CSI、旧 alt screen 与旧文本");
  await surface.write(Buffer.from([0xf0, 0x9f]));
  await surface.reset(); await surface.write("UTF8_RESET", true);
  assert.ok(surface.dump().startsWith("UTF8_RESET"));
  report.push("replacement：清除半截 UTF-8 parser 状态");
  await surface.reset();
  async function cursor() {
    surface.events.length = 0;
    await surface.write("\x1b[6n");
    let response = "";
    while (!response.includes("R")) response += (await surface.wait(2)).bytes.toString();
    return response;
  }
  // 每次 frame 后的首块即边界输出；CPR 来自 parser，不依赖 selection 文本表示。
  for (const width of [420, 630, 350]) {
    await surface.reset();
    const fence = await surface.frame(width, 300);
    const before = addon.grid(surface.id);
    assert.deepEqual(before, { columns: fence.x, rows: fence.y }, "栅栏必须等于真实 surface 网格");
    const columns = fence.x;
    assert.ok(columns > 2);
    await surface.write("X".repeat(columns - 1) + "界Z");
    const after = addon.grid(surface.id);
    const lines = surface.dump().split("\n");
    const position = await cursor();
    console.log(JSON.stringify({ case: "resize-wide", width, fence: { columns, rows: fence.y }, before, after, lines: lines.slice(0, 2), cursor: position }));
    assert.deepEqual(after, before, "首块解析期间网格不能漂移");
    // 上游 selectionString wide char with header 用例规定：选中 spacer_head 会包含下一行宽字。
    // 因此不能以第一行 dump 是否带“界”判断其物理位置；第二行与 CPR 必须同时吻合。
    assert.equal(lines[1].trimEnd(), "界Z", "宽字必须位于第二行开头");
    assert.equal(position, "\x1b[2;4R", "宽字占第二行两列，Z 占第三列");
    assert.equal(lines[0].slice(0, columns - 1), "X".repeat(columns - 1));
    report.push(`resize 宽字：${columns} 列，真实网格一致，CPR=2;4`);
  }
  await surface.reset();
  const asciiFence = await surface.frame(490, 300);
  assert.deepEqual(addon.grid(surface.id), { columns: asciiFence.x, rows: asciiFence.y });
  await surface.write("X".repeat(asciiFence.x) + "Y");
  assert.equal(await cursor(), "\x1b[2;2R", "ASCII 首块也必须按栅栏列数换行");
  const asciiLines = surface.dump().split("\n");
  assert.equal(asciiLines[0].trimEnd(), "X".repeat(asciiFence.x));
  assert.equal(asciiLines[1].trimEnd(), "Y");
  report.push("resize ASCII：精确列边界及 CPR=2;2");
  await surface.reset(); surface.events.length = 0;
  await surface.write("\x1b[c\x1b[5n\x1b[6n", true);
  await delay(200);
  assert.equal(surface.events.filter((event) => event.kind === 2).length, 0, "replay 不允许 DA/DSR 回写");
  await surface.write("\x1b[c\x1b[6n");
  await surface.wait(2);
  report.push("replay 无 DA/DSR 回写，实时同序列可产生回写（非门禁掩盖）");
  console.log(JSON.stringify({ gate: "G6", cases: report }, null, 2));
} finally { await surface.destroy(); }
