import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import XTermHeadless from "@xterm/headless";
import { TaskStatus } from "@coflux/protocol";
import { DeviceClient, utf8 } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";

const PORT = 8847;
const { Terminal } = XTermHeadless;
const FIXTURE_ROOT = resolve(import.meta.dirname, "..", "fixtures", "terminal");
const PLAYER = join(FIXTURE_ROOT, "player.mjs");
const FIXTURE_FILES = ["claude-cli.json", "codex-cli.json", "tui-vim.json"];
let stack;
let device;
const repos = [];

before(async () => {
  chmodSync(PLAYER, 0o755);
  stack = await startStack({ port: PORT, daemonEnv: { COFLUX_SHELL: PLAYER } });
  device = await DeviceClient.pair(stack);
  await device.openRelay();
});

after(async () => {
  device?.close();
  await stack?.stop();
  for (const repo of repos) repo.cleanup();
});

async function createFixtureSession(fixture) {
  const repo = mkRepo();
  repos.push(repo);
  writeFileSync(join(repo.dir, ".coflux-terminal-fixture.json"), JSON.stringify(fixture));
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name: fixture.name });
  device.executePrepared(await device.waitPrepared("projectValidate"));
  const project = await device.control.waitFor(
    (message) => message.case === "projectCreated" && message.project.name === fixture.name,
    `${fixture.name} project`,
  );
  const workspace = await device.control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.projectId === project.project.id && message.workspace.isMain,
    `${fixture.name} workspace`,
  );
  const title = `oracle-${randomUUID()}`;
  device.control.send({ case: "taskCreate", workspaceId: workspace.workspace.id, title });
  const idle = await device.control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.title === title,
    `${fixture.name} task`,
  );
  device.control.send({
    case: "taskStart",
    taskId: idle.task.id,
    cols: fixture.initial.cols,
    rows: fixture.initial.rows,
  });
  device.executePrepared(await device.waitPrepared("sessionCreate"));
  const running = await device.control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.id === idle.task.id && message.task.status === TaskStatus.RUNNING,
    `${fixture.name} running`,
  );
  return running.task.sessionId;
}

async function snapshotContaining(sessionId, marker, dimensions, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const attached = await device.attach(sessionId, dimensions);
    last = utf8(attached.ansiSnapshot ?? new Uint8Array());
    if (last.includes(marker)) return attached;
    await sleep(20);
  }
  throw new Error(`snapshot 未出现 marker ${marker}; tail=${last.slice(-120)}`);
}

async function writeTerminal(terminal, bytes) {
  await new Promise((resolveWrite) => terminal.write(bytes, resolveWrite));
}

function cellState(cell) {
  return {
    chars: cell.getChars(),
    width: cell.getWidth(),
    fgMode: cell.getFgColorMode(),
    bgMode: cell.getBgColorMode(),
    fg: cell.getFgColor(),
    bg: cell.getBgColor(),
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    inverse: Boolean(cell.isInverse()),
  };
}

function assertBufferEquivalent(actual, expected, cols, label) {
  assert.deepEqual(
    {
      type: actual.type,
      cursorX: actual.cursorX,
      cursorY: actual.cursorY,
      baseY: actual.baseY,
      viewportY: actual.viewportY,
      length: actual.length,
    },
    {
      type: expected.type,
      cursorX: expected.cursorX,
      cursorY: expected.cursorY,
      baseY: expected.baseY,
      viewportY: expected.viewportY,
      length: expected.length,
    },
    `${label} buffer metadata 不等价`,
  );
  for (let row = 0; row < actual.length; row += 1) {
    const actualLine = actual.getLine(row);
    const expectedLine = expected.getLine(row);
    assert.ok(actualLine && expectedLine, `${label} line ${row} 应存在`);
    assert.equal(
      actualLine.isWrapped,
      expectedLine.isWrapped,
      `${label} line ${row} wrap 不等价: ${JSON.stringify(actualLine.translateToString(true))} / ${JSON.stringify(expectedLine.translateToString(true))}`,
    );
    for (let col = 0; col < cols; col += 1) {
      const actualCell = actualLine.getCell(col);
      const expectedCell = expectedLine.getCell(col);
      assert.ok(actualCell && expectedCell, `${label} cell ${row},${col} 应存在`);
      assert.deepEqual(cellState(actualCell), cellState(expectedCell), `${label} cell ${row},${col} 不等价`);
    }
  }
}

function assertTerminalEquivalent(actual, expected, label) {
  assert.deepEqual(
    { cols: actual.cols, rows: actual.rows, active: actual.buffer.active.type },
    { cols: expected.cols, rows: expected.rows, active: expected.buffer.active.type },
    `${label} terminal geometry/active buffer 不等价`,
  );
  assertBufferEquivalent(actual.buffer.normal, expected.buffer.normal, actual.cols, `${label} normal`);
  assertBufferEquivalent(actual.buffer.alternate, expected.buffer.alternate, actual.cols, `${label} alternate`);
  assert.deepEqual(
    {
      applicationCursorKeysMode: actual.modes.applicationCursorKeysMode,
      applicationKeypadMode: actual.modes.applicationKeypadMode,
      bracketedPasteMode: actual.modes.bracketedPasteMode,
    },
    {
      applicationCursorKeysMode: expected.modes.applicationCursorKeysMode,
      applicationKeypadMode: expected.modes.applicationKeypadMode,
      bracketedPasteMode: expected.modes.bracketedPasteMode,
    },
    `${label} guaranteed modes 不等价`,
  );
}

async function assertFixture(fixture) {
  const sessionId = await createFixtureSession(fixture);
  let dimensions = { ...fixture.initial };
  let holderEpoch;
  let inputSeq = 0n;
  let resizeSeq = 0n;
  let snapshot;

  for (const stage of fixture.stages) {
    const attached = await snapshotContaining(sessionId, stage.marker, dimensions);
    holderEpoch = attached.holderEpoch;
    snapshot = attached;
    if (stage.resizeAfter) {
      resizeSeq += 1n;
      device.send("ptyResize", {
        requestId: randomUUID(),
        sessionId,
        holderEpoch,
        resizeSeq,
        cols: stage.resizeAfter.cols,
        rows: stage.resizeAfter.rows,
      });
      dimensions = { ...stage.resizeAfter };
    }
    inputSeq += 1n;
    const from = device.mark();
    device.send("ptyInput", {
      requestId: randomUUID(),
      sessionId,
      holderEpoch,
      inputSeq,
      data: Uint8Array.of(0),
    });
    await device.waitFor(
      (message) => message.case === "ptyInputAck" && message.sessionId === sessionId && message.appliedThroughSeq >= inputSeq,
      `${fixture.name} barrier ack`,
      10000,
      from,
    );
  }

  assert.ok(snapshot?.ansiSnapshot?.byteLength > 0, `${fixture.name} 必须取得真实 sessiond snapshot`);
  assert.equal(snapshot.cols, dimensions.cols);
  assert.equal(snapshot.rows, dimensions.rows);
  assert.ok(
    Buffer.from(snapshot.ansiSnapshot).includes(Buffer.from("\x1b[?25l")),
    `${fixture.name} snapshot 必须保留隐藏光标状态`,
  );

  const original = new Terminal({ ...fixture.initial, scrollback: 2000, allowProposedApi: true });
  for (const stage of fixture.stages) {
    await writeTerminal(original, Buffer.from(stage.dataBase64, "base64"));
    if (stage.resizeAfter) original.resize(stage.resizeAfter.cols, stage.resizeAfter.rows);
  }
  const restored = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 2000, allowProposedApi: true });
  await writeTerminal(restored, snapshot.ansiSnapshot);

  if (process.env.COFLUX_VT_DEBUG) {
    const snapshotBytes = Buffer.from(snapshot.ansiSnapshot);
    const altOffset = snapshotBytes.indexOf(Buffer.from("\x1b[?1049h"));
    const summary = (terminal) => ({
      active: terminal.buffer.active.type,
      normal: {
        length: terminal.buffer.normal.length,
        baseY: terminal.buffer.normal.baseY,
        cursorY: terminal.buffer.normal.cursorY,
        cursorX: terminal.buffer.normal.cursorX,
        lines: Array.from({ length: terminal.buffer.normal.length }, (_, row) => terminal.buffer.normal.getLine(row)?.translateToString(true)),
      },
    });
    console.error(fixture.name, {
      original: summary(original),
      restored: summary(restored),
      normalSnapshotTail: snapshotBytes.subarray(Math.max(0, altOffset - 160), altOffset).toString("latin1").replaceAll("\x1b", "<ESC>"),
      snapshotTailHex: snapshotBytes.subarray(-160).toString("hex"),
    });
  }

  const tail = Buffer.from(fixture.tailBase64, "base64");
  await writeTerminal(original, tail);
  await writeTerminal(restored, tail);
  assertTerminalEquivalent(restored, original, `${fixture.name} snapshot+tail`);

  const tailMarker = utf8(tail).match(/[A-Z]+_TAIL_DONE/)?.[0];
  if (tailMarker) {
    await device.waitFor(
      (message) => message.case === "ptyOutput" && message.sessionId === sessionId && utf8(message.data).includes(tailMarker),
      `${fixture.name} real tail`,
    );
  }
  original.dispose();
  restored.dispose();
}

test("独立 xterm 6 oracle：Claude/Codex/TUI 原流与 sessiond snapshot+tail 等价", async () => {
  for (const file of FIXTURE_FILES) {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, file), "utf8"));
    await assertFixture(fixture);
  }
});
