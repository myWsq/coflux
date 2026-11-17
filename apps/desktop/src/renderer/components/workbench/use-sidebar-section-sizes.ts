import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  dragSectionWeights,
  persistSectionWeights,
  readSectionWeights,
  resetSectionPair,
  type SectionWeights,
  type SectionWeightsStore,
  type SidebarSectionId,
} from "@/components/workbench/sidebar-section-sizes";
import { SIDEBAR_SECTIONS_KEY } from "@/config";

/**
 * 侧栏三区高度的拖拽（VS Code SplitView 口径）：分隔条只在相邻两区间挪空间，松手落盘，
 * 双击回到这对区段的默认比例。指针流程与 use-sidebar-width.ts 完全同一套——pointer
 * capture、拖动期间全局 row-resize 光标与禁选、capture 丢失即收尾；纯计算在
 * sidebar-section-sizes.ts。像素测量来自各 section 元素的实时高度（pointerdown 时取一次），
 * 所以 min-height 被 CSS 顶住时拖拽也不会跳。
 */

const SECTION_WEIGHTS_STORE: SectionWeightsStore = { storage: localStorage, key: SIDEBAR_SECTIONS_KEY };

export type SectionDividerControl = {
  isResizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
};

export type SidebarSectionSizes = {
  /** 用作该区的 flex-grow（basis 0），比例即高度分配。 */
  weights: SectionWeights;
  /** 挂到各 section 元素上，拖拽开始时量它们的实际像素高。 */
  sectionRef: (id: SidebarSectionId) => (element: HTMLElement | null) => void;
  /** 一条分隔条的全部事件；above/below 是它贴着的两个区。 */
  divider: (above: SidebarSectionId, below: SidebarSectionId) => SectionDividerControl;
};

export function useSidebarSectionSizes(): SidebarSectionSizes {
  const [weights, setWeights] = useState(() => readSectionWeights(SECTION_WEIGHTS_STORE));
  const [resizingPair, setResizingPair] = useState<string | null>(null);
  const weightsRef = useRef(weights);
  const elementsRef = useRef(new Map<SidebarSectionId, HTMLElement>());
  const dragRef = useRef<{
    pointerId: number;
    pair: string;
    above: SidebarSectionId;
    below: SidebarSectionId;
    startY: number;
    abovePx: number;
    belowPx: number;
    startWeights: SectionWeights;
    handle: HTMLDivElement;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  function updateWeights(next: SectionWeights) {
    weightsRef.current = next;
    setWeights(next);
  }

  function restoreDragEnvironment() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.documentElement.style.cursor = drag.previousCursor;
    document.documentElement.style.userSelect = drag.previousUserSelect;
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }

  function finishDrag(pointerId: number) {
    if (dragRef.current?.pointerId !== pointerId) return;
    restoreDragEnvironment();
    setResizingPair(null);
    persistSectionWeights(SECTION_WEIGHTS_STORE, weightsRef.current);
  }

  useEffect(
    () => () => {
      restoreDragEnvironment();
    },
    [],
  );

  return {
    weights,
    sectionRef: (id) => (element) => {
      if (element) elementsRef.current.set(id, element);
      else elementsRef.current.delete(id);
    },
    divider(above, below) {
      const pair = `${above}/${below}`;
      return {
        isResizing: resizingPair === pair,
        onPointerDown(event) {
          if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
          const abovePx = elementsRef.current.get(above)?.getBoundingClientRect().height;
          const belowPx = elementsRef.current.get(below)?.getBoundingClientRect().height;
          if (!abovePx || !belowPx) return;
          event.preventDefault();
          const handle = event.currentTarget;
          dragRef.current = {
            pointerId: event.pointerId,
            pair,
            above,
            below,
            startY: event.clientY,
            abovePx,
            belowPx,
            startWeights: weightsRef.current,
            handle,
            previousCursor: document.documentElement.style.cursor,
            previousUserSelect: document.documentElement.style.userSelect,
          };
          handle.setPointerCapture(event.pointerId);
          document.documentElement.style.cursor = "row-resize";
          document.documentElement.style.userSelect = "none";
          setResizingPair(pair);
        },
        onPointerMove(event) {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || drag.pair !== pair) return;
          updateWeights(
            dragSectionWeights(drag.startWeights, drag.above, drag.below, drag.abovePx, drag.belowPx, event.clientY - drag.startY),
          );
        },
        onPointerUp(event) {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || drag.pair !== pair) return;
          updateWeights(
            dragSectionWeights(drag.startWeights, drag.above, drag.below, drag.abovePx, drag.belowPx, event.clientY - drag.startY),
          );
          finishDrag(event.pointerId);
        },
        onPointerCancel(event) {
          finishDrag(event.pointerId);
        },
        onLostPointerCapture(event) {
          finishDrag(event.pointerId);
        },
        onDoubleClick() {
          const next = resetSectionPair(weightsRef.current, above, below);
          updateWeights(next);
          persistSectionWeights(SECTION_WEIGHTS_STORE, next);
        },
      };
    },
  };
}
