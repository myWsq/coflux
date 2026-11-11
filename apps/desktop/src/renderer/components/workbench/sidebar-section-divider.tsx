import type { SectionDividerControl } from "@/components/workbench/use-sidebar-section-sizes";
import { cn } from "@/lib/utils";

/**
 * 侧栏区段之间那条横向分隔条：静止时就是 1px 的 border 分界线（接替原来 section 的
 * border-t/border-b），hover/拖动时整条变主题色，命中区上下各扩 3px。与右缘宽度手柄
 * （sidebar-resize-handle.tsx）同一套视觉与指针口径，只是方向转了 90°。
 */
export function SidebarSectionDivider({ control }: { control: SectionDividerControl }) {
  return (
    <div className="group/divider relative z-10 shrink-0">
      <div
        className={cn(
          "h-px transition-colors",
          control.isResizing ? "bg-primary/70" : "bg-border group-hover/divider:bg-primary/50",
        )}
      />
      <div
        className="absolute inset-x-0 -bottom-[3px] -top-[3px] cursor-row-resize touch-none"
        onDoubleClick={control.onDoubleClick}
        onLostPointerCapture={control.onLostPointerCapture}
        onPointerCancel={control.onPointerCancel}
        onPointerDown={control.onPointerDown}
        onPointerMove={control.onPointerMove}
        onPointerUp={control.onPointerUp}
      />
    </div>
  );
}
