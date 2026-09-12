import { useEffect, type RefObject } from "react";

import type { WorkspaceTerminalHandle } from "@/components/workbench/workspace-terminal";
import { desktop } from "@/config";
import type { DesktopCommand } from "@/desktop-bridge";

type GlobalShortcutsOptions = {
  /** 当前选中工作区所属项目 id；无选中工作区时为 null，⌘N 安静忽略 */
  selectedProjectId: string | null;
  /** 只指向 active 的 WorkspaceTerminal 实例（见 workbench.tsx 的 ref 挂载方式），
   * 保活但隐藏的实例永远读不到这份 ref，天然满足"只有 active 实例响应"的约束 */
  activeTerminalRef: RefObject<WorkspaceTerminalHandle | null>;
  onOpenCreateWorkspaceMenu: (projectId: string) => void;
  onToggleHelp: () => void;
  /** ⌘, 与应用菜单的「设置…」：打开设置页，幂等，挂起期间照样受理 */
  onOpenSettings: () => void;
  /** 挂起时键盘与原生菜单命令都不再作用于终端：设置页这类整页覆盖层盖住工作台时传 true，
   * 否则 ⌘T/⌘W/⌘1 会落到一个看不见也点不到的终端上。 */
  isSuspended?: boolean;
};

/**
 * 全局快捷键（plan 015）：纯 ⌘ 前缀 + ⌘/ 帮助面板。
 *
 * 挂在 window capture 阶段而非某个 xterm 的 attachCustomKeyEventHandler：capture 先于
 * xterm 隐藏 textarea 的 target 阶段触发，preventDefault + stopPropagation 能在组合键
 * 被编码下发给远端 shell 之前拦下来（见 terminal-pane.tsx 的 onData 通道）。
 *
 * 数字/字母键用 event.code（物理键位），不用 event.key——避免非 QWERTY 布局下
 * 键位随字符映射漂移（如 Dvorak 下 KeyT 物理位置对应的字符并非 "t"，但拦截的是
 * 物理键位，这与大多数系统级/编辑器快捷键的语义一致）。
 *
 * 桌面 app（plan 103）：原生菜单项不注册 accelerator（只展示键位），键全部落到页面；点菜单
 * 走桥接的 onCommand，与键盘路径共用同一组处理函数。
 */
export function useGlobalShortcuts({
  selectedProjectId,
  activeTerminalRef,
  onOpenCreateWorkspaceMenu,
  onToggleHelp,
  onOpenSettings,
  isSuspended = false,
}: GlobalShortcutsOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 单修饰 ⌘ 前缀：⌘/ 与下面的字母/数字键共用同一判定；再按一次 ⌘/ 由调用方 toggle 关闭。
      const hasPrefix = event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (!hasPrefix) return;

      // ⌘,（macOS 的「偏好设置」惯例）不受挂起影响：打开设置页是幂等的，人在设置页里按它
      // 也该什么都不坏——挂起是为了别让终端快捷键落到看不见的终端上，与这条无关。
      if (event.code === "Comma") {
        event.preventDefault();
        event.stopPropagation();
        onOpenSettings();
        return;
      }

      if (isSuspended) return;

      if (event.code === "Slash") {
        event.preventDefault();
        event.stopPropagation();
        onToggleHelp();
        return;
      }

      const terminal = activeTerminalRef.current;
      switch (event.code) {
        case "KeyT":
          event.preventDefault();
          event.stopPropagation();
          terminal?.createTerminal();
          return;
        case "KeyW":
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
  }, [selectedProjectId, activeTerminalRef, onOpenCreateWorkspaceMenu, onToggleHelp, onOpenSettings, isSuspended]);

  // 原生菜单命令：与上面的键位一一对应。
  useEffect(
    () =>
      desktop.onCommand((command: DesktopCommand) => {
        // 与键盘同一口径：菜单里的「设置…」任何时候都受理，其余命令在覆盖层打开时挂起。
        if (command === "open-settings") {
          onOpenSettings();
          return;
        }
        if (isSuspended) return;
        const terminal = activeTerminalRef.current;
        switch (command) {
          case "create-terminal":
            terminal?.createTerminal();
            return;
          case "close-terminal":
            terminal?.closeActiveTab();
            return;
          case "create-workspace":
            if (selectedProjectId) onOpenCreateWorkspaceMenu(selectedProjectId);
            return;
          case "previous-tab":
            terminal?.selectRelativeTab(-1);
            return;
          case "next-tab":
            terminal?.selectRelativeTab(1);
            return;
          case "toggle-help":
            onToggleHelp();
            return;
        }
      }),
    [selectedProjectId, activeTerminalRef, onOpenCreateWorkspaceMenu, onToggleHelp, onOpenSettings, isSuspended],
  );
}
