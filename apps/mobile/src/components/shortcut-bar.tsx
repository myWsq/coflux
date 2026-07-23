import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type ShortcutBarProps = {
  disabled: boolean;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onSend: (bytes: string) => void;
};

const ARROW_KEYS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" } as const;

/** 快捷键条：手机没有物理 Esc/Tab/方向键/Ctrl 组合键，驱动 TUI agent（菜单导航、
 * 中断、斜杠命令、确认）离不开这些键。Ctrl 是"粘滞"武装态而非弹一套字母键盘——
 * 武装后下一个从系统键盘/输入法真实敲入的字符会被 TerminalPane 转成控制字节
 * （见 terminal-pane.tsx 的 ctrlArmed 处理），复用系统键盘做字母源。 */
export function ShortcutBar({ disabled, ctrlArmed, onToggleCtrl, onSend }: ShortcutBarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-secondary px-2 py-1.5"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.375rem)" }}
    >
      <Key label="Esc" disabled={disabled} onClick={() => onSend("\x1b")} />
      <Key label="Tab" disabled={disabled} onClick={() => onSend("\t")} />
      <Key
        label="Ctrl"
        disabled={disabled}
        active={ctrlArmed}
        onClick={onToggleCtrl}
      />
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      <Key icon={<ArrowUp className="size-4" />} disabled={disabled} onClick={() => onSend(ARROW_KEYS.up)} />
      <Key icon={<ArrowDown className="size-4" />} disabled={disabled} onClick={() => onSend(ARROW_KEYS.down)} />
      <Key icon={<ArrowLeft className="size-4" />} disabled={disabled} onClick={() => onSend(ARROW_KEYS.left)} />
      <Key icon={<ArrowRight className="size-4" />} disabled={disabled} onClick={() => onSend(ARROW_KEYS.right)} />
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      <Key icon={<CornerDownLeft className="size-4" />} label="Enter" disabled={disabled} onClick={() => onSend("\r")} />
    </div>
  );
}

function Key({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label?: string;
  icon?: ReactNode;
  active?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      // 阻止按钮抢走焦点：保持 xterm 隐藏 textarea 的焦点不丢，否则触屏软键盘会随之收起。
      onPointerDown={(event) => event.preventDefault()}
      className={cn(
        "flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-3 text-xs font-medium",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground active:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
