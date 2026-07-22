import { useEffect, type RefObject } from "react";

import { isStandalone } from "@/components/workbench/use-shortcut-modifier";
import type { WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";

type GlobalShortcutsOptions = {
  /** 当前选中工作区所属项目 id；无选中工作区时为 null，Cmd+Ctrl+N 安静忽略 */
  selectedProjectId: string | null;
  /** 只指向 active 的 WorkspaceTerminal 实例（见 workbench.tsx 的 ref 挂载方式），
   * 保活但隐藏的实例永远读不到这份 ref，天然满足"只有 active 实例响应"的约束 */
  activeTerminalRef: RefObject<WorkspaceTerminalHandle | null>;
  onOpenCreateWorkspaceMenu: (projectId: string) => void;
  onToggleHelp: () => void;
};

/**
 * 全局快捷键（plan 015）：Cmd+Ctrl 前缀 + Cmd+/ 帮助面板。
 *
 * 挂在 window capture 阶段而非某个 xterm 的 attachCustomKeyEventHandler：capture 先于
 * xterm 隐藏 textarea 的 target 阶段触发，preventDefault + stopPropagation 能在组合键
 * 被编码下发给远端 shell 之前拦下来（见 terminal-pane.tsx 的 onData 通道）。
 *
 * 数字/字母键用 event.code（物理键位），不用 event.key——避免非 QWERTY 布局下
 * 键位随字符映射漂移（如 Dvorak 下 KeyT 物理位置对应的字符并非 "t"，但拦截的是
 * 物理键位，这与大多数系统级/编辑器快捷键的语义一致）。
 */
export function useGlobalShortcuts({
  selectedProjectId,
  activeTerminalRef,
  onOpenCreateWorkspaceMenu,
  onToggleHelp,
}: GlobalShortcutsOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Cmd+/：不带 Ctrl，与下面的 Cmd+Ctrl 前缀互斥；再按一次由调用方 toggle 关闭。
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "Slash") {
        event.preventDefault();
        event.stopPropagation();
        onToggleHelp();
        return;
      }

      // 前缀：PWA standalone 下浏览器无 tab 栏，⌘T/⌘W/… 释放给页面，前缀降级为纯 ⌘；
      // 浏览器 tab 模式仍用 ⌃⌘（Cmd 单修饰在 tab 下被 chrome 层硬保留，网页拦不住）。
      const hasPrefix = isStandalone()
        ? event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
        : event.metaKey && event.ctrlKey;
      if (!hasPrefix) return;

      const terminal = activeTerminalRef.current;
      switch (event.code) {
        case "KeyT":
          event.preventDefault();
          event.stopPropagation();
          terminal?.createTerminal();
          return;
        case "KeyW":
          // ponytail: standalone 下纯 ⌘W 可能仍被 OS/浏览器抢去关 PWA 窗口（无 Keyboard Lock 时
          // preventDefault 拦不住）——需在真机 PWA 验证；拦不住则此键退回 ⌃⌘W。
          event.preventDefault();
          event.stopPropagation();
          terminal?.closeActiveTab();
          return;
        case "KeyN":
          event.preventDefault();
          event.stopPropagation();
          if (selectedProjectId) onOpenCreateWorkspaceMenu(selectedProjectId);
          return;
        case "BracketLeft":
          event.preventDefault();
          event.stopPropagation();
          terminal?.selectRelativeTab(-1);
          return;
        case "BracketRight":
          event.preventDefault();
          event.stopPropagation();
          terminal?.selectRelativeTab(1);
          return;
      }

      if (event.code.startsWith("Digit")) {
        const digit = Number(event.code.slice("Digit".length));
        if (digit >= 1 && digit <= 9) {
          event.preventDefault();
          event.stopPropagation();
          terminal?.selectTabByIndex(digit - 1);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [selectedProjectId, activeTerminalRef, onOpenCreateWorkspaceMenu, onToggleHelp]);
}
