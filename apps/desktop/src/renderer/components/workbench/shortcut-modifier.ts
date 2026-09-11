/**
 * 快捷键前缀（plan 015 / 103 / 106）：Electron 窗口没有浏览器 chrome，原生菜单项不注册这些
 * accelerator（registerAccelerator: false，只展示键位），⌘T/⌘W/⌘N/⌘1-9/⌘[ ] 全部落到页面，
 * 前缀就是纯 ⌘。展示与拦截共用这一份常量。
 */

/** 展示用修饰键序列，遵循 macOS 菜单惯例顺序 ⌃⌥⇧⌘。 */
export const SHORTCUT_MODIFIERS: readonly string[] = ["⌘"];

/** tooltip 用的紧凑前缀。 */
export const SHORTCUT_MODIFIER_PREFIX = SHORTCUT_MODIFIERS.join("");
