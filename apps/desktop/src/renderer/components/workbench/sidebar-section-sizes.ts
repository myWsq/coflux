/**
 * Sidebar section sizes (plan follow-up to 20261111-sidebar-follow-selection): the three sidebar
 * sections (「当前」 / 「项目」 / 「设备」) are explicit panes the user sizes with draggable
 * dividers, VS Code SplitView style — drag moves space between the two adjacent panes only,
 * content that falls short of its pane leaves blank space, content that overflows scrolls within.
 *
 * Weights are flex-grow values over flex-basis 0, so they are proportions of the available
 * height; a hidden section (「当前」 without live agents) simply drops out and the rest share
 * the space by their unchanged weights. Pure math lives here; the pointer plumbing is in
 * use-sidebar-section-sizes.ts. Storage and key are arguments for the reason
 * `command-palette-recent.ts` gives.
 */

export type SidebarSectionId = "current" | "projects" | "devices";

export type SectionWeights = Record<SidebarSectionId, number>;

export const DEFAULT_SECTION_WEIGHTS: SectionWeights = { current: 0.25, projects: 0.5, devices: 0.25 };

/** A pane never shrinks below this (its sticky header plus about one row). */
export const MIN_SECTION_PX = 64;

export type SectionWeightsStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const SECTION_IDS: readonly SidebarSectionId[] = ["current", "projects", "devices"];

/** Every failure mode — no value, bad JSON, missing or non-positive entries — reads as defaults. */
export function readSectionWeights(store: SectionWeightsStore): SectionWeights {
  try {
    const raw = store.storage.getItem(store.key);
    if (!raw) return DEFAULT_SECTION_WEIGHTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SECTION_WEIGHTS;
    const weights = {} as SectionWeights;
    for (const id of SECTION_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SECTION_WEIGHTS;
      weights[id] = value;
    }
    return weights;
  } catch {
    return DEFAULT_SECTION_WEIGHTS;
  }
}

export function persistSectionWeights(store: SectionWeightsStore, weights: SectionWeights): void {
  try {
    store.storage.setItem(store.key, JSON.stringify(weights));
  } catch {
    // Remembering the pane sizes is a convenience; failing to is not worth an error.
  }
}

/**
 * One divider drag: the pane above was `abovePx` tall and the pane below `belowPx` at pointer
 * down, the pointer has moved `deltaPx` (positive = down). Returns the pair's new weights,
 * redistributing only their combined weight, clamped so neither pane goes under `minPx` — when
 * the pair is already tighter than two minimums, the split is left where it was.
 */
export function dragSectionWeights(
  weights: SectionWeights,
  above: SidebarSectionId,
  below: SidebarSectionId,
  abovePx: number,
  belowPx: number,
  deltaPx: number,
  minPx: number = MIN_SECTION_PX,
): SectionWeights {
  const pairPx = abovePx + belowPx;
  const pairWeight = weights[above] + weights[below];
  if (pairPx <= 0 || pairWeight <= 0) return weights;
  if (pairPx < 2 * minPx) return weights;
  const nextAbovePx = Math.min(pairPx - minPx, Math.max(minPx, abovePx + deltaPx));
  return {
    ...weights,
    [above]: (pairWeight * nextAbovePx) / pairPx,
    [below]: (pairWeight * (pairPx - nextAbovePx)) / pairPx,
  };
}

/** The divider's double-click: the pair goes back to the default ratio, keeping its combined share. */
export function resetSectionPair(
  weights: SectionWeights,
  above: SidebarSectionId,
  below: SidebarSectionId,
): SectionWeights {
  const pairWeight = weights[above] + weights[below];
  const defaultPair = DEFAULT_SECTION_WEIGHTS[above] + DEFAULT_SECTION_WEIGHTS[below];
  if (pairWeight <= 0 || defaultPair <= 0) return weights;
  return {
    ...weights,
    [above]: (pairWeight * DEFAULT_SECTION_WEIGHTS[above]) / defaultPair,
    [below]: (pairWeight * DEFAULT_SECTION_WEIGHTS[below]) / defaultPair,
  };
}
