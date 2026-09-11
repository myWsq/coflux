/**
 * 终端链接的"该不该打开"判定（plan 109）。
 *
 * 桌面版里普通点击终端只是聚焦/选中，不该跳浏览器；只有修饰键+点击才打开，与 VS Code / iTerm 一致：
 * macOS 按 ⌘（metaKey），其它平台按 Ctrl（ctrlKey）。xterm 的 Linkifier 在 mousedown/mouseup 落到
 * 同一链接时无条件调用 link.activate，不看修饰键，插件也没有"要求修饰键"的选项，所以门控只能落在
 * 激活函数里。这里两个键任一为真即打开，不做平台判断（桌面版只出 macOS 包，ctrlKey 是给跨平台留门）。
 *
 * 纯函数、只吃事件字段：渲染层单测在纯 Node 下跑，没有 DOM，模块里不能碰 MouseEvent/window 运行时值。
 */

/** 判定所需的鼠标事件字段（MouseEvent 的子集，便于无 DOM 单测）。 */
export type TerminalLinkClick = {
  metaKey?: boolean;
  ctrlKey?: boolean;
  /** MouseEvent.button：0 为主键。缺省视为主键。 */
  button?: number;
};

/** 是否应该把这次点击当成"打开链接"：主键 + ⌘/Ctrl 任一。 */
export function shouldOpenTerminalLink(click: TerminalLinkClick): boolean {
  if (click.button !== undefined && click.button !== 0) return false; // 中键/右键不算打开
  return click.metaKey === true || click.ctrlKey === true;
}
