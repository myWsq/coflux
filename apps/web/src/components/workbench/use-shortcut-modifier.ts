import { useSyncExternalStore } from "react";

import { isDesktop } from "@/desktop-bridge";

/**
 * PWA standalone 检测 —— 快捷键前缀的单一数据源（plan 015 backlog）。
 *
 * standalone（含 window-controls-overlay）下浏览器无 tab 栏，⌘T/⌘W/⌘N/⌘1-9/⌘[ ] 这些
 * 在浏览器 tab 模式被 chrome 层硬保留的键释放给页面，preventDefault 拦得住，于是前缀从
 * ⌃⌘ 降级为纯 ⌘。浏览器 tab 模式仍走 ⌃⌘（见 use-global-shortcuts.ts 的动机注释）。
 *
 * 桌面 app（plan 103）≡ standalone：Electron 窗口没有浏览器 chrome，原生菜单项不注册这些
 * accelerator（registerAccelerator: false，只展示键位），键全部落到页面，判定与 PWA 完全一致。
 *
 * 拦截逻辑读 isStandalone()（每次 keydown 现读，天然动态）；展示文案用 useIsStandalone()
 * 订阅 display-mode 变化，安装/卸载 PWA、进出全屏时随之重渲染，避免提示与实际键位对不上。
 */
const STANDALONE_QUERY = "(display-mode: standalone), (display-mode: window-controls-overlay)";

export function isStandalone(): boolean {
  if (isDesktop()) return true;
  return window.matchMedia?.(STANDALONE_QUERY).matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia?.(STANDALONE_QUERY);
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}

export function useIsStandalone(): boolean {
  return useSyncExternalStore(subscribe, isStandalone, () => false);
}

/** 展示用修饰键序列，遵循 macOS 菜单惯例顺序 ⌃⌥⇧⌘。 */
export function shortcutModifiers(standalone: boolean): string[] {
  return standalone ? ["⌘"] : ["⌃", "⌘"];
}

/** tooltip 用的紧凑前缀，如 "⌘" 或 "⌃⌘"。 */
export function shortcutModifierPrefix(standalone: boolean): string {
  return shortcutModifiers(standalone).join("");
}
