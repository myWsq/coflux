import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTerminalKeyOwner, type TerminalKeyEvent } from "./terminal-key-ownership";

type Modifiers = { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean };

/** 造一个「像 KeyboardEvent」的最小事件。带上 type 只为标明这条断言针对哪种事件——判定本身不读它。 */
function key(code: string, modifiers: Modifiers = {}, type = "keydown"): TerminalKeyEvent {
  const event = {
    code,
    metaKey: modifiers.meta === true,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: modifiers.shift === true,
    type,
  };
  return event;
}

test("⌘ 组合键整类让给应用：⌘C/⌘V 之外，⌘X/⌘Z/⌘R 也不许被终端吃掉", () => {
  for (const code of ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyR", "Enter", "Backspace"]) {
    assert.equal(decideTerminalKeyOwner(key(code, { meta: true })), "app", code);
  }
});

test("⇧⌘ 同样是应用层（原生菜单里就有 ⇧⌘W），不能跟着 use-global-shortcuts 的纯 ⌘ 前缀把 ⇧ 排除掉", () => {
  assert.equal(decideTerminalKeyOwner(key("KeyZ", { meta: true, shift: true })), "app");
  assert.equal(decideTerminalKeyOwner(key("KeyW", { meta: true, shift: true })), "app");
});

test("判定只看修饰键、不看事件类型：keyup / keypress 与 keydown 同一结论", () => {
  assert.equal(decideTerminalKeyOwner(key("KeyV", { meta: true }, "keyup")), "app");
  assert.equal(decideTerminalKeyOwner(key("KeyV", { meta: true }, "keypress")), "app");
  assert.equal(decideTerminalKeyOwner(key("KeyA", { meta: true }, "keyup")), "select-all");
  assert.equal(decideTerminalKeyOwner(key("KeyC", {}, "keyup")), "terminal");
});

test("⌘A 先全选再让开（普通 shell 里今天就是这个双重语义）；⇧⌘A 不特殊，与上游条件一致", () => {
  assert.equal(decideTerminalKeyOwner(key("KeyA", { meta: true })), "select-all");
  assert.equal(decideTerminalKeyOwner(key("KeyA", { meta: true, shift: true })), "app");
  // 带 Ctrl/⌥ 的 A 根本不是 ⌘A，照常进终端
  assert.equal(decideTerminalKeyOwner(key("KeyA", { meta: true, ctrl: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyA", { meta: true, alt: true })), "terminal");
});

test("Ctrl / ⌥ 前缀与无修饰键照常进终端：Ctrl+C 要中断、Ctrl+D 要送 EOF、⌥ 是 Meta/ESC 前缀", () => {
  assert.equal(decideTerminalKeyOwner(key("KeyC", { ctrl: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyD", { ctrl: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyF", { alt: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyC", { ctrl: true, shift: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyV", { meta: true, ctrl: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyV", { meta: true, alt: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyA")), "terminal");
  assert.equal(decideTerminalKeyOwner(key("Enter")), "terminal");
  assert.equal(decideTerminalKeyOwner(key("Enter", { shift: true })), "terminal");
});

test("字段缺省视为未按下：只有 metaKey 明确为真才轮到应用", () => {
  assert.equal(decideTerminalKeyOwner({ code: "KeyC" }), "terminal");
  assert.equal(decideTerminalKeyOwner({ code: "KeyC", metaKey: true }), "app");
  assert.equal(decideTerminalKeyOwner({ code: "KeyA", metaKey: true }), "select-all");
});

test("⌘⌥ 数字与方向键是分组快捷键，归应用：keyup 也不能落进终端", () => {
  for (const code of ["Digit1", "Digit5", "Digit9", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    assert.equal(decideTerminalKeyOwner(key(code, { meta: true, alt: true })), "app", code);
    assert.equal(decideTerminalKeyOwner(key(code, { meta: true, alt: true }, "keyup")), "app", `${code} keyup`);
  }
});

test("其余带 ⌥ 的组合照旧归终端：⌥ 是 Meta，⌘⌥0、⌘⌥ 字母、⌥ 数字 / 方向键都不是分组快捷键", () => {
  assert.equal(decideTerminalKeyOwner(key("Digit0", { meta: true, alt: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("KeyV", { meta: true, alt: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("Digit1", { alt: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("ArrowLeft", { alt: true })), "terminal");
  // 多一个修饰键就不是那组快捷键
  assert.equal(decideTerminalKeyOwner(key("Digit1", { meta: true, alt: true, shift: true })), "terminal");
  assert.equal(decideTerminalKeyOwner(key("ArrowLeft", { meta: true, alt: true, ctrl: true })), "terminal");
});

test("⌘\\ 与 ⇧⌘\\（拆分）本来就在 ⌘ 那一档，归应用", () => {
  assert.equal(decideTerminalKeyOwner(key("Backslash", { meta: true })), "app");
  assert.equal(decideTerminalKeyOwner(key("Backslash", { meta: true, shift: true })), "app");
  assert.equal(decideTerminalKeyOwner(key("IntlBackslash", { meta: true })), "app");
});
