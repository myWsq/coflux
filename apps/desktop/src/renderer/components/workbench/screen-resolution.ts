/**
 * The remote screen's resolution choice (plan 20261011-screen-resolution-presets).
 *
 * A screen tab either lets the remote virtual display follow the tab's size 1:1 in points
 * (「跟随窗口」, the default) or pins it to one of a few fixed sizes in points; the scale still
 * follows the local screen (`displayRequest`). The choice is remembered per remote device on this
 * machine, scoped by server address like the screen tab records, so reopening that device's screen
 * uses it. Pure: storage is injected.
 */

/** A fixed remote display size in points; `null` is 「跟随窗口」. */
export type ScreenResolution = { widthPoints: number; heightPoints: number } | null;

/** The fixed sizes offered, in points, in menu order. */
export const SCREEN_RESOLUTION_PRESETS: readonly { widthPoints: number; heightPoints: number }[] = [
  { widthPoints: 1280, heightPoints: 800 },
  { widthPoints: 1440, heightPoints: 900 },
  { widthPoints: 1512, heightPoints: 982 },
  { widthPoints: 1728, heightPoints: 1117 },
  { widthPoints: 1920, heightPoints: 1080 },
];

/** The value stored and used as the menu's radio value for 「跟随窗口」. */
export const SCREEN_RESOLUTION_FOLLOW = "follow";

export type ScreenResolutionStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;

/** The choice as a string: `follow` or `1440x900`. */
export function screenResolutionValue(resolution: ScreenResolution): string {
  return resolution ? `${resolution.widthPoints}x${resolution.heightPoints}` : SCREEN_RESOLUTION_FOLLOW;
}

/** A stored or menu value back to a choice; anything that is not one of the presets is 「跟随窗口」. */
export function parseScreenResolution(value: unknown): ScreenResolution {
  if (typeof value !== "string") return null;
  return SCREEN_RESOLUTION_PRESETS.find((preset) => screenResolutionValue(preset) === value) ?? null;
}

/** The status bar's label for a choice. */
export function screenResolutionLabel(resolution: ScreenResolution): string {
  return resolution ? `${resolution.widthPoints}×${resolution.heightPoints}` : "跟随窗口";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDevices(store: ScreenResolutionStore): Record<string, string> {
  let parsed: unknown;
  try {
    const raw = store.storage.getItem(store.key);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.devices)) return {};
  const devices: Record<string, string> = {};
  for (const [daemonId, value] of Object.entries(parsed.devices)) {
    const resolution = parseScreenResolution(value);
    if (resolution) devices[daemonId] = screenResolutionValue(resolution);
  }
  return devices;
}

/** The device's remembered choice; storage that throws or holds junk reads as 「跟随窗口」. */
export function readScreenResolution(store: ScreenResolutionStore, daemonId: string): ScreenResolution {
  return parseScreenResolution(readDevices(store)[daemonId]);
}

/** Best-effort write; 「跟随窗口」 removes the device's entry. */
export function writeScreenResolution(store: ScreenResolutionStore, daemonId: string, resolution: ScreenResolution): boolean {
  const devices = readDevices(store);
  if (resolution) devices[daemonId] = screenResolutionValue(resolution);
  else delete devices[daemonId];
  try {
    store.storage.setItem(store.key, JSON.stringify({ version: STORAGE_VERSION, devices }));
    return true;
  } catch {
    return false;
  }
}
