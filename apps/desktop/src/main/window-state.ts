import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 窗口大小/位置记忆（plan 106）：bounds 存 userData 下独立的 window-state.json（不混进用户手编的
 * settings.json），关窗/退出时保存、启动恢复。恢复前校验与当前某个显示器可见区域相交，
 * 不相交（外接屏拔掉、分辨率变了）则回默认尺寸居中。纯函数部分不 import electron，便于单测。
 */

export type WindowBounds = { x: number; y: number; width: number; height: number };

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const;
export const MIN_WINDOW_SIZE = { width: 1024, height: 640 } as const;

/** 与显示器至少要重叠这么多像素（两个方向都算），否则视为离屏——一条几像素的边角抓不住标题栏。 */
export const MIN_VISIBLE_PX = 64;

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** 文件内容 → bounds；不是 JSON 对象、字段缺失/非整数、小于最小窗口尺寸都当没存过。 */
export function parseWindowBounds(raw: string | null | undefined): WindowBounds | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { x, y, width, height } = parsed as Record<string, unknown>;
    if (!isInteger(x) || !isInteger(y) || !isInteger(width) || !isInteger(height)) return null;
    if (width < MIN_WINDOW_SIZE.width || height < MIN_WINDOW_SIZE.height) return null;
    return { x, y, width, height };
  } catch {
    return null;
  }
}

/** 两个矩形的重叠区在两个方向上都不少于 MIN_VISIBLE_PX */
export function visibleOn(bounds: WindowBounds, display: WindowBounds): boolean {
  const overlapWidth = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
  const overlapHeight = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
  return overlapWidth >= MIN_VISIBLE_PX && overlapHeight >= MIN_VISIBLE_PX;
}

/** 保存过且在某个显示器上可见 → 用它；否则 null，调用方按默认尺寸居中。 */
export function resolveWindowBounds(saved: WindowBounds | null, displays: readonly WindowBounds[]): WindowBounds | null {
  if (!saved) return null;
  return displays.some((display) => visibleOn(saved, display)) ? saved : null;
}

export function readWindowBounds(path: string): WindowBounds | null {
  try {
    return parseWindowBounds(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 尽力而为：写不进去（磁盘满、目录只读）只影响下次启动的位置，不影响本次运行。 */
export function writeWindowBounds(path: string, bounds: WindowBounds, onError?: (error: unknown) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(bounds)}\n`);
  } catch (error) {
    onError?.(error);
  }
}
