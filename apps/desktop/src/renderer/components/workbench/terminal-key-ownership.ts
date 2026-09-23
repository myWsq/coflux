/**
 * 按键归属判定（plan 20260918）：⌘ 组合键属于应用，不属于终端。
 *
 * 2.1.0 起 ⌘C / ⌘V 在 Claude Code 这类 agent TUI 里失灵，⌘V 还会往 TUI 里打进一个字面量 v；
 * 同一个 app 的普通 shell 里两个键都正常。病根不在菜单也不在剪贴板代码，而在于终端把 ⌘ 键
 * 提前吃掉了：2.1.0 打开了 kitty 键盘协议（vtExtensions.kittyKeyboard，见 terminal-pane.tsx），
 * 而协议是由 PTY 里的程序在运行时协商的——Claude Code 协商，普通 shell 不协商，所以这个 bug
 * 只在 TUI 里出现。一旦协商上，xterm 把**每一个**按键都编码成 CSI u 序列（metaKey 当作 kitty
 * 的 SUPER 位），并顺手把事件消费掉；被页面消费掉的事件不会再回到浏览器，原生「编辑」菜单里
 * role: copy / paste 那几项的 accelerator 于是永远等不到事件。TUI 那头收到带 SUPER 位的 v，
 * 不认这个修饰键，就插了个 v。
 *
 * 影响面比用户注意到的两个键宽：⌘X / ⌘Z 同理，⌘R（窗口重新载入）在协商了 kitty 的 TUI 里
 * 同样是哑的。所以判定覆盖整类 ⌘ 组合，而不是 ⌘C/⌘V 白名单。
 *
 * 判定接在 xterm 的 attachCustomKeyEventHandler 上：它是 CoreBrowserTerminal._keyDown 的第一句，
 * 返回 false 时 xterm 立刻 return——kitty 编码器不跑，事件也没被页面消费，原样回到浏览器，
 * 菜单 accelerator 这才匹配得上。kitty 协议本身保持开启：Shift+Enter 之类的组合键还得靠它编码，
 * 这里只是把 ⌘ 组合从终端手里收回来。
 *
 * ## 为什么是三岔而不是布尔
 *
 * ⌘A 在 2.0.2、以及今天的非 kitty shell 里**两件事都做**：xterm 的旧编码器把「⌘ 且无 Ctrl/⌥/⇧」
 * 这个形状映射成 SELECT_ALL 并调 selectAll()，且**不**取消事件（随包发布的 sourcemap 源码
 * src/common/input/Keyboard.ts 里 isMac && !altKey && !ctrlKey && !shiftKey && metaKey 那一支），
 * 于是缓冲区全选与原生 role: selectAll 同时发生。把 ⌘A 并进「让开」那一档会让普通 shell 里的
 * 全选丢掉——那是回归，不是修复；所以它单列一档：先全选，再让开。⇧⌘A 不特殊，与上游条件一致。
 *
 * ## 为什么只看修饰键、不看 event.type
 *
 * xterm 在 _keyUp / _keyPress 里同样会问这个 handler。若只在 keydown 上让开，协商了 kitty
 * REPORT_EVENT_TYPES 的 TUI 会收到一个「没见过按下的松开」。判定因此对三种事件一视同仁。
 *
 * ## 为什么排除 Ctrl 与 ⌥
 *
 * 这两个修饰键带终端语义：Ctrl+C 要中断、Ctrl+D 要送 EOF，⌥ 是 Meta/ESC 前缀，都必须继续进终端。
 * ⇧ 则**不**排除：⇧⌘ 在 macOS 上同样是应用层（原生菜单里就有 ⇧⌘W）。也不做平台分支——桌面版
 * 只出 macOS 包，别的平台上 metaKey 是 Super/Win 键，一样没有终端语义。
 *
 * ## ⌘⌥ 的例外：分组快捷键
 *
 * 编辑器分组（plan 20260923-terminal-split-groups）占用了 ⌘⌥1–9（分组内第 N 个 Tab）与 ⌘⌥←→↑↓
 * （按方向移动焦点）。全局快捷键在 window capture 阶段抢下 keydown，但 keyup 仍会走到 xterm：若按上面
 * 「带 ⌥ 归终端」的规则，协商了 kitty REPORT_EVENT_TYPES 的 TUI 就会收到一个没见过按下的松开——
 * 正是本模块要防的那种故障。所以恰好这几组 ⌘⌥ 组合（不带 Ctrl、不带 ⇧）归应用；其余带 ⌥ 的组合
 * 照旧归终端（⌥ 是 Meta）。
 *
 * 纯函数、只吃事件字段：渲染层单测在纯 Node 下跑，没有 DOM，模块里不能碰 KeyboardEvent 运行时值。
 */

/** 判定所需的键盘事件字段（KeyboardEvent 的子集，便于无 DOM 单测）。 */
export type TerminalKeyEvent = {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** KeyboardEvent.code：物理键位。与 use-global-shortcuts.ts 同口径，不随键盘布局漂移。 */
  code?: string;
};

/**
 * terminal = 照常交给 xterm；app = 让给应用（原生菜单）；
 * select-all = 先在终端里全选，再让给应用（⌘A 的双重语义，见模块注释）。
 */
export type TerminalKeyOwner = "terminal" | "app" | "select-all";

const GROUP_CHORD_CODES = new Set([
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

/** 这个按键归谁。 */
export function decideTerminalKeyOwner(event: TerminalKeyEvent): TerminalKeyOwner {
  if (event.metaKey !== true) return "terminal";
  // ⌘⌥1–9 and ⌘⌥ arrows are the app's group shortcuts; checked before the ⌥ → terminal rule.
  if (event.altKey === true && event.ctrlKey !== true && event.shiftKey !== true && GROUP_CHORD_CODES.has(event.code ?? "")) return "app";
  if (event.ctrlKey === true || event.altKey === true) return "terminal";
  if (event.shiftKey !== true && event.code === "KeyA") return "select-all";
  return "app";
}
