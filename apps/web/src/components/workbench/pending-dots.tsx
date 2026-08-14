import { useEffect, useState } from "react";

/**
 * 执行中指示：固定像素点阵，两块 2×4 在格子上平移。
 * 不用 Unicode 盲文——UI 字体没有稳定盲文度量，空格和实心格宽度不同，
 * 看起来会乱晃、越撑越宽。
 */
const COLS = 6;
const ROWS = 4;
const BAR = 2;
/** 左条起点；右条对称贴在 COLS-BAR-left。来回 4 帧。 */
const LEFT = [0, 1, 2, 1] as const;
const INTERVAL_MS = 140;
const CELLS = COLS * ROWS;

function isOn(frame: number, col: number): boolean {
  const left = LEFT[frame]!;
  const right = COLS - BAR - left;
  return (col >= left && col < left + BAR) || (col >= right && col < right + BAR);
}

type Listener = () => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function startClock() {
  if (timer !== null) return;
  timer = setInterval(() => {
    frame = (frame + 1) % LEFT.length;
    for (const listener of listeners) listener();
  }, INTERVAL_MS);
}

function stopClock() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function usePendingFrame() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const listener = () => setIndex(frame);
    listeners.add(listener);
    startClock();
    setIndex(frame);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stopClock();
    };
  }, []);
  return index;
}

export function PendingDots({ label }: { label?: string }) {
  const current = usePendingFrame();
  return (
    <span
      className="grid shrink-0 gap-px"
      style={{
        width: 17,
        height: 11,
        gridTemplateColumns: `repeat(${COLS}, 2px)`,
        gridTemplateRows: `repeat(${ROWS}, 2px)`,
      }}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {Array.from({ length: CELLS }, (_, i) => {
        const on = isOn(current, i % COLS);
        return (
          <span
            key={i}
            className={on ? "rounded-full bg-muted-foreground" : "rounded-full bg-muted-foreground/20"}
          />
        );
      })}
    </span>
  );
}
