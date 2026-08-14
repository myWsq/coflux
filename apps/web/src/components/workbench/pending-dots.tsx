/**
 * Cursor Glass / assistant-ui 同款：4×4 SVG 圆点，每颗点自己闪。
 * 见 https://www.assistant-ui.com/docs/ui/dot-matrix （loading = randomized twinkle）
 * 不用 Unicode 盲文——UI 字体度量不稳，会把行撑开。
 */

const GRID = 4;

/** 打散相邻点的相位，避免整列一起闪（assistant-ui 的 bit-mix hash）。 */
function hash(n: number, salt: number, range: number) {
  let h = (Math.imul(n, 374761393) + Math.imul(salt, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) % range) / 1000;
}

const DOTS = Array.from({ length: GRID * GRID }, (_, i) => ({
  cx: (i % GRID) + 0.5,
  cy: Math.floor(i / GRID) + 0.5,
  duration: 0.9 + hash(i, 2, 700),
  delay: -hash(i, 1, 1200),
}));

export function PendingDots({ label }: { label?: string }) {
  return (
    <svg
      viewBox={`0 0 ${GRID} ${GRID}`}
      className="size-3 shrink-0 text-muted-foreground"
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {DOTS.map((dot, i) => (
        <circle
          key={i}
          cx={dot.cx}
          cy={dot.cy}
          r={0.32}
          fill="currentColor"
          className="coflux-dot-twinkle"
          style={{ animationDuration: `${dot.duration}s`, animationDelay: `${dot.delay}s` }}
        />
      ))}
    </svg>
  );
}
