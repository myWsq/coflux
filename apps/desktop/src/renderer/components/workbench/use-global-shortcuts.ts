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
  /** ⌘, 与应用菜单的「设置…」：开关设置页；挂起期间照样受理 */
  onToggleSettings: () => void;
  /**
   * ⌘P and the 「快速跳转…」 menu item: toggle the navigation palette. Handled ahead of the
   * suspension gate — the palette suspends everything else while it is open, and a shortcut that
   * suspended itself could not be closed with the same key that opened it.
   */
  onTogglePalette: () => void;
  /** 挂起时键盘与原生菜单命令都不再作用于终端：设置页这类整页覆盖层盖住工作台时传 true，
   * 否则 ⌘T/⌘W/⌘1 会落到一个看不见也点不到的终端上。 */
  isSuspended?: boolean;
};

/**
 * 全局快捷键（plan 015）：纯 ⌘ 前缀 + ⌘/ 帮助面板。
 *
 * Editor groups (plan 20260923-terminal-split-groups) add two more modifier sets: ⌘⇧ (only ⌘⇧\,
 * split down) and ⌘⌥ (the Nth tab of the focused group, focus the adjacent group). Keys are
 * dispatched by the exact modifier set, and the bare-⌘ set is not widened for the new keys: ⇧⌘W is
 * the native close-window accelerator (main/menu.ts), and accepting an extra ⇧ would swallow it.
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
  onToggleSettings,
  onTogglePalette,
  isSuspended = false,
}: GlobalShortcutsOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Exact modifier sets: bare ⌘, ⌘⇧ and ⌘⌥ each take their own keys; anything with Ctrl is left alone.
      if (!event.metaKey || event.ctrlKey) return;
      const bare = !event.shiftKey && !event.altKey;
      const withShift = event.shiftKey && !event.altKey;
      const withAlt = event.altKey && !event.shiftKey;
      if (!bare && !withShift && !withAlt) return;
      // ⌘\ may be reported as IntlBackslash on ISO keyboards.
      const isBackslash = event.code === "Backslash" || event.code === "IntlBackslash";

      if (bare) {
        // ⌘,（macOS 的「偏好设置」惯例）不受挂起影响：它开关的就是那个覆盖层本身，人在设置页里
        // 按它应当关掉设置页——挂起是为了别让终端快捷键落到看不见的终端上，与这条无关。
        if (event.code === "Comma") {
          event.preventDefault();
          event.stopPropagation();
          onToggleSettings();
          return;
        }

        // ⌘P sits on the same side of the gate as ⌘,: the palette suspends the whole workbench set
        // while it is open (⌘[ / ⌘] have to reach its filter tabs), so a ⌘P placed after the gate
        // could never be pressed a second time to close what it opened.
        if (event.code === "KeyP") {
          event.preventDefault();
          event.stopPropagation();
          onTogglePalette();
          return;
        }
      }

      if (isSuspended) return;
      const terminal = activeTerminalRef.current;

      if (withShift) {
        // ⌘⇧\ splits downward. Nothing else with ⇧ belongs here: ⇧⌘W is the native close-window accelerator.
        if (!isBackslash) return;
        event.preventDefault();
        event.stopPropagation();
        terminal?.splitTerminal("down");
        return;
      }

      if (withAlt) {
        // ⌘⌥1–9: the focused group's Nth tab. ⌘⌥ arrows: focus the adjacent group.
        // terminal-key-ownership.ts classifies exactly these chords as the app's, so their keyup
        // never reaches a TUI either.
        if (event.code.startsWith("Digit")) {
          const digit = Number(event.code.slice("Digit".length));
          if (digit < 1 || digit > 9) return;
          event.preventDefault();
          event.stopPropagation();
          terminal?.selectTabByIndex(digit - 1);
          return;
        }
        const side =
          event.code === "ArrowLeft"
            ? "left"
            : event.code === "ArrowRight"
              ? "right"
              : event.code === "ArrowUp"
                ? "up"
                : event.code === "ArrowDown"
                  ? "down"
                  : null;
        if (!side) return;
        event.preventDefault();
        event.stopPropagation();
        terminal?.focusGroupInDirection(side);
        return;
      }

      if (event.code === "Slash") {
        event.preventDefault();
        event.stopPropagation();
        onToggleHelp();
        return;
      }

      if (isBackslash) {
        event.preventDefault();
        event.stopPropagation();
        terminal?.splitTerminal("right");
        return;
      }

      switch (event.code) {
        case "KeyT":
          event.preventDefault();
          event.stopPropagation();
          terminal?.toggleNewTabMenu();
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

      // ⌘1–9 focuses the Nth group in layout order (plan 20260923-terminal-split-groups); it used
      // to select the Nth tab, which is ⌘⌥1–9 now.
      if (event.code.startsWith("Digit")) {
        const digit = Number(event.code.slice("Digit".length));
        if (digit >= 1 && digit <= 9) {
          event.preventDefault();
          event.stopPropagation();
          terminal?.focusGroupByIndex(digit - 1);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [selectedProjectId, activeTerminalRef, onOpenCreateWorkspaceMenu, onToggleHelp, onToggleSettings, onTogglePalette, isSuspended]);

  // 原生菜单命令：与上面的键位一一对应。
  useEffect(
    () =>
      desktop.onCommand((command: DesktopCommand) => {
        // 与键盘同一口径：菜单里的「设置…」与「快速跳转…」任何时候都受理，其余命令在覆盖层打开时挂起。
        if (command === "open-settings") {
          onToggleSettings();
          return;
        }
        if (command === "toggle-palette") {
          onTogglePalette();
          return;
        }
        if (isSuspended) return;
        const terminal = activeTerminalRef.current;
        switch (command) {
          case "new-tab":
            terminal?.toggleNewTabMenu();
            return;
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
          case "split-right":
            terminal?.splitTerminal("right");
            return;
          case "split-down":
            terminal?.splitTerminal("down");
            return;
          case "focus-group-left":
            terminal?.focusGroupInDirection("left");
            return;
          case "focus-group-right":
            terminal?.focusGroupInDirection("right");
            return;
          case "focus-group-up":
            terminal?.focusGroupInDirection("up");
            return;
          case "focus-group-down":
            terminal?.focusGroupInDirection("down");
            return;
          case "new-browser-tab":
            terminal?.openBrowserTab();
            return;
          case "toggle-help":
            onToggleHelp();
            return;
        }
        // ⌘1–9 / ⌘⌥1–9 typed inside a browser page, forwarded by the main process (plan 20260924-desktop-browser-tab).
        const digit = /^(focus-group|select-tab)-([1-9])$/.exec(command);
        if (digit) {
          const index = Number(digit[2]) - 1;
          if (digit[1] === "focus-group") terminal?.focusGroupByIndex(index);
          else terminal?.selectTabByIndex(index);
        }
      }),
    [selectedProjectId, activeTerminalRef, onOpenCreateWorkspaceMenu, onToggleHelp, onToggleSettings, onTogglePalette, isSuspended],
  );
}
