import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { SIDEBAR_WIDTH_KEY } from "@/config";

/**
 * 侧栏宽度：**工作台侧栏与设置页左栏共用同一份**。
 *
 * 两处各自持有状态是不行的——设置页一盖上来，侧栏宽度会从用户调过的值跳回另一个默认值，
 * 看起来就像换了一条侧栏。所以宽度提到 Workbench 调用一次，两边都拿同一份 control，
 * 在哪边拖都是同一个值、同一个 localStorage key。
 *
 * 拖动实现保持原样（pointer capture + 松手落盘 + 双击回默认），没有改用 Astryx 的 useResizable：
 * 那会换掉已经上线的手感与持久化口径，本次改动不该顺带动它。
 */

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readSidebarWidth() {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored === null || stored.trim() === "") return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(Number(stored));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function persistSidebarWidth(width: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // localStorage 不可用时仍保留本次会话中的宽度。
  }
}

/** 侧栏宽度 + 拖拽手柄要用的一整套事件；交给 SidebarResizeHandle 渲染。 */
export type SidebarWidthControl = {
  width: number;
  isResizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
};

export function useSidebarWidth(): SidebarWidthControl {
  const [width, setWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    handle: HTMLDivElement;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  function updateWidth(next: number) {
    const clamped = clampSidebarWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
  }

  function restoreResizeEnvironment() {
    const resize = resizeRef.current;
    if (!resize) return;
    resizeRef.current = null;
    document.documentElement.style.cursor = resize.previousCursor;
    document.documentElement.style.userSelect = resize.previousUserSelect;
    if (resize.handle.hasPointerCapture(resize.pointerId)) {
      resize.handle.releasePointerCapture(resize.pointerId);
    }
  }

  function finishResize(pointerId: number) {
    if (resizeRef.current?.pointerId !== pointerId) return;
    restoreResizeEnvironment();
    setIsResizing(false);
    persistSidebarWidth(widthRef.current);
  }

  useEffect(
    () => () => {
      restoreResizeEnvironment();
    },
    [],
  );

  return {
    width,
    isResizing,
    onPointerDown(event) {
      if (!event.isPrimary || event.button !== 0 || resizeRef.current) return;
      event.preventDefault();
      const handle = event.currentTarget;
      resizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: widthRef.current,
        handle,
        previousCursor: document.documentElement.style.cursor,
        previousUserSelect: document.documentElement.style.userSelect,
      };
      handle.setPointerCapture(event.pointerId);
      document.documentElement.style.cursor = "col-resize";
      document.documentElement.style.userSelect = "none";
      setIsResizing(true);
    },
    onPointerMove(event) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      updateWidth(resize.startWidth + event.clientX - resize.startX);
    },
    onPointerUp(event) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      updateWidth(resize.startWidth + event.clientX - resize.startX);
      finishResize(event.pointerId);
    },
    onPointerCancel(event) {
      finishResize(event.pointerId);
    },
    onLostPointerCapture(event) {
      finishResize(event.pointerId);
    },
    onDoubleClick() {
      updateWidth(DEFAULT_SIDEBAR_WIDTH);
      persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    },
  };
}
