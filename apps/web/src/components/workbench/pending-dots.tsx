/**
 * 工作区活动点阵：assistant-ui DotMatrix 同款（NxN SVG 圆点 + 每点独立闪）。
 * 见 https://www.assistant-ui.com/docs/ui/dot-matrix
 * 不用 Unicode 盲文——UI 字体度量不稳，会把行撑开。
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export type ActivityDotsStatus = "active" | "approval" | "question" | "done";

type Blink = { duration: number; delay: number; lo: number };

type StateConfig = {
  grid: number;
  color: string;
  glyph?: Set<number>;
  base?: number;
  dim?: number;
  blink?: (i: number, row: number, col: number) => Blink;
};

/** 打散相邻点的相位，避免整列一起闪（assistant-ui 的 bit-mix hash）。 */
function hash(n: number, salt: number, range: number) {
  let h = (Math.imul(n, 374761393) + Math.imul(salt, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) % range) / 1000;
}

function glyph(grid: number, dots: [number, number][]) {
  return new Set(dots.map(([row, col]) => row * grid + col));
}

/** 执行中仍用 4×4：5×5 全亮闪太密。字形态必须 5×5，否则勾 / 感叹 / 省略对不上。 */
const CHECK = glyph(5, [
  [1, 4],
  [2, 3],
  [3, 0],
  [3, 2],
  [4, 1],
]);
const BANG = glyph(5, [
  [0, 2],
  [1, 2],
  [2, 2],
  [4, 2],
]);
const ELLIPSIS = glyph(5, [
  [2, 0],
  [2, 2],
  [2, 4],
]);

const STATES: Record<ActivityDotsStatus, StateConfig> = {
  active: {
    grid: 4,
    color: "text-muted-foreground",
    blink: (i) => ({
      duration: 0.9 + hash(i, 2, 700),
      delay: -hash(i, 1, 1200),
      lo: 0.15,
    }),
  },
  approval: {
    grid: 5,
    color: "text-warning",
    glyph: BANG,
    dim: 0.12,
    blink: () => ({ duration: 1.6, delay: 0, lo: 0.45 }),
  },
  question: {
    grid: 5,
    color: "text-warning",
    glyph: ELLIPSIS,
    dim: 0.12,
    blink: (_i, _row, col) => ({ duration: 1.2, delay: -col * 0.09, lo: 0.2 }),
  },
  done: {
    grid: 5,
    color: "text-success",
    glyph: CHECK,
    dim: 0.12,
  },
};

export function ActivityDots({ status, label }: { status: ActivityDotsStatus; label?: string }) {
  const config = STATES[status];
  const { grid } = config;
  return (
    <svg
      viewBox={`0 0 ${grid} ${grid}`}
      className={cn("size-3 shrink-0", config.color)}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {Array.from({ length: grid * grid }, (_, i) => {
        const row = Math.floor(i / grid);
        const col = i % grid;
        const on = !config.glyph || config.glyph.has(i);
        const hi = on ? (config.base ?? 1) : (config.dim ?? 0.15);
        const blink = on ? config.blink?.(i, row, col) : undefined;
        const lo = blink?.lo ?? hi;
        return (
          <circle
            key={i}
            cx={col + 0.5}
            cy={row + 0.5}
            r={0.32}
            fill="currentColor"
            className="coflux-dot-twinkle"
            style={
              {
                "--coflux-dot-hi": hi,
                "--coflux-dot-lo": lo,
                animationDuration: `${blink?.duration ?? 1}s`,
                animationDelay: `${blink?.delay ?? 0}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </svg>
  );
}
