import { useEffect, useState } from "react";

/**
 * Cursor 式 pending：5 格盲文点阵（2×4）里两团点在漂。
 * 帧是预烘焙的，运行时只换字符串，避免每 tick 算点。
 */
const FRAMES = [
  "⢠⡀⠀⠀⣁",
  "⠀⣄⠀⠀⣁",
  "⠀⢠⡀⢈⡀",
  "⠀⢠⠄⢈⠁",
  "⠀⠀⡤⢁⠁",
  "⠀⠀⡢⡉⠀",
  "⠀⠀⠦⡉⠀",
  "⠀⠀⠖⣁⠀",
  "⠀⠘⠊⢄⠀",
  "⠀⠘⢁⢄⠀",
  "⠀⠋⠀⡤⠀",
  "⠘⠁⠀⡤⠀",
  "⠘⠁⠀⠦⠀",
  "⠋⠀⠀⠦⠀",
  "⠁⠀⠀⠔⠒",
  "⠁⠀⠀⠰⠚",
  "⠂⠀⠀⠰⠜",
  "⠂⠀⠀⠀⠾",
  "⠂⠀⠀⠀⡴",
  "⠂⠀⠀⠀⡰",
  "⠆⠀⠀⠀⢠",
  "⡤⠀⠀⠀⢠",
  "⣠⠄⠀⠀⠈",
] as const;

const INTERVAL_MS = 90;

type Listener = () => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function startClock() {
  if (timer !== null) return;
  timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
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
  return FRAMES[index];
}

export function PendingDots({ label }: { label?: string }) {
  const glyph = usePendingFrame();
  return (
    <span
      className="inline-block w-[5ch] shrink-0 select-none font-mono text-[11px] leading-none text-muted-foreground"
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {glyph}
    </span>
  );
}
