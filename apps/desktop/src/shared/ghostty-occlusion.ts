/** CSS 像素矩形；与 DOM/AppKit 无关，边缘相接不算遮挡。 */
export type OcclusionRect = { x: number; y: number; width: number; height: number };
export type OcclusionCandidate = { rect: OcclusionRect; visible: boolean; emptyHost: boolean };

export function isGhosttyOccluded(terminal: OcclusionRect, candidates: readonly OcclusionCandidate[]): boolean {
  const hasArea = (rect: OcclusionRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
  if (!hasArea(terminal)) return false;
  return candidates.some(({ rect, visible, emptyHost }) => visible && !emptyHost && hasArea(rect)
    && rect.x < terminal.x + terminal.width && rect.x + rect.width > terminal.x
    && rect.y < terminal.y + terminal.height && rect.y + rect.height > terminal.y);
}
