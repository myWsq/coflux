import type { SidebarWidthControl } from "@/components/workbench/use-sidebar-width";
import { cn } from "@/lib/utils";

/**
 * 侧栏右缘那条拖拽手柄：工作台侧栏与设置页左栏共用同一份宽度 control，所以手柄也共用这一个组件，
 * 两边的手感、命中区、双击回默认完全一致。
 *
 * 裸元素而非 Astryx 组件：它是贴在侧栏边缘的一条 6px 命中区（自身透明，只在 hover/拖动时显出中间
 * 那道 1px 线），属于交互层的装置，不承担任何布局。
 */
export function SidebarResizeHandle({ control }: { control: SidebarWidthControl }) {
  return (
    <div
      className="group/resize absolute inset-y-0 -right-[3px] z-20 w-1.5 cursor-col-resize touch-none"
      onDoubleClick={control.onDoubleClick}
      onLostPointerCapture={control.onLostPointerCapture}
      onPointerCancel={control.onPointerCancel}
      onPointerDown={control.onPointerDown}
      onPointerMove={control.onPointerMove}
      onPointerUp={control.onPointerUp}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          control.isResizing ? "bg-primary/70" : "bg-transparent group-hover/resize:bg-primary/50",
        )}
      />
    </div>
  );
}
