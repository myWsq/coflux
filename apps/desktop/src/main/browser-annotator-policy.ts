import type {
  DesktopAnnotatorAnchor,
  DesktopAnnotatorBox,
  DesktopAnnotatorElement,
  DesktopAnnotatorLocator,
  DesktopAnnotatorPin,
  DesktopAnnotatorRegion,
  DesktopAnnotatorSource,
  DesktopAnnotatorState,
  DesktopAnnotatorViewport,
  DesktopBrowserRect,
} from "../shared/desktop-bridge";

/**
 * Pure rules of browser annotations (plan 20260929-browser-annotations), main-process side: what
 * the renderer may ask of a page guest, what a page message may carry, and where an element's
 * screenshot is cut from the captured page. Everything crossing into main is re-validated here:
 * renderer payloads because every IPC payload is, page messages because the element data comes
 * from the page's own DOM.
 */

const MAX_PINS = 500;
const MAX_TOKEN = 32;
const MAX_ID = 128;
const MAX_SELECTOR = 2000;
const MAX_DOM_PATH = 4000;
const MAX_TEXT = 500;
const MAX_SHORT = 200;
const MAX_VALUE = 500;
const MAX_LIST = 24;
const MAX_MAP = 40;
const MAX_URL = 4000;
/** Elements one pick or one pin carries (a shift-click selection, a region's inner elements). */
export const MAX_TARGETS = 24;
const MAX_OUTLINED = 8;
/** A page message larger than this is not one of ours. */
export const MAX_PAGE_MESSAGE_BYTES = 256 * 1024;
/** Padding around an element's screenshot, in CSS pixels. */
export const SCREENSHOT_PADDING = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function list(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, max))
    .filter((item) => item.length > 0)
    .slice(0, MAX_LIST);
}

function map(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_MAP) break;
    const name = text(key, 64);
    const content = text(raw, MAX_VALUE);
    if (!name || !content) continue;
    out[name] = content;
    count += 1;
  }
  return out;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isId(value: unknown, max = MAX_ID): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

export function sanitizeLocator(value: unknown): DesktopAnnotatorLocator | null {
  if (!isRecord(value)) return null;
  return {
    selector: text(value.selector, MAX_SELECTOR),
    domPath: text(value.domPath, MAX_DOM_PATH),
    tag: text(value.tag, 64).toLowerCase(),
    text: text(value.text, MAX_TEXT),
    elementId: text(value.elementId, MAX_SHORT),
    classes: list(value.classes, MAX_SHORT),
  };
}

function sanitizeAnchor(value: unknown): DesktopAnnotatorAnchor {
  if (!isRecord(value)) return null;
  if (value.kind === "pick" && isId(value.token, MAX_TOKEN)) return { kind: "pick", token: value.token };
  if (value.kind === "pin" && isId(value.id)) return { kind: "pin", id: value.id, scroll: value.scroll === true };
  return null;
}

/** A region relative to its first element: any finite offset, a positive size. */
export function sanitizeRegion(value: unknown): DesktopAnnotatorRegion | null {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** `browserAnnotatorSync` from the renderer. */
export function sanitizeAnnotatorSync(payload: unknown): { guestId: number; state: DesktopAnnotatorState } | null {
  if (!isRecord(payload) || !isRecord(payload.state)) return null;
  const guestId = payload.guestId;
  if (typeof guestId !== "number" || !Number.isInteger(guestId) || guestId <= 0) return null;
  const raw = payload.state;
  const pins: DesktopAnnotatorPin[] = [];
  if (Array.isArray(raw.pins)) {
    for (const entry of raw.pins.slice(0, MAX_PINS)) {
      if (!isRecord(entry) || !isId(entry.id) || !Array.isArray(entry.targets)) continue;
      const number = finite(entry.number);
      const targets = entry.targets
        .slice(0, MAX_TARGETS)
        .map(sanitizeLocator)
        .filter((target): target is DesktopAnnotatorLocator => target !== null);
      if (number === null || targets.length === 0) continue;
      pins.push({
        id: entry.id,
        number: Math.max(0, Math.floor(number)),
        resolved: entry.resolved === true,
        targets,
        region: sanitizeRegion(entry.region),
      });
    }
  }
  const outlined = Array.isArray(raw.outlined) ? raw.outlined.filter((id): id is string => isId(id)).slice(0, MAX_OUTLINED) : [];
  return {
    guestId,
    state: {
      mode: raw.mode === true,
      capture: raw.capture === true,
      pins,
      anchor: sanitizeAnchor(raw.anchor),
      outlined,
    },
  };
}

/**
 * Whether a state needs the page instrumented at all. The capture flag and the outlines never do
 * on their own: a card is always anchored, and a tab with no annotate mode, pins or anchor must
 * not get a debugger.
 */
export function annotatorStateNeedsPage(state: DesktopAnnotatorState): boolean {
  return state.mode || state.pins.length > 0 || state.anchor !== null;
}

export function sanitizeBox(value: unknown): DesktopAnnotatorBox | null {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

export function sanitizeViewport(value: unknown): DesktopAnnotatorViewport | null {
  if (!isRecord(value)) return null;
  const width = finite(value.width);
  const height = finite(value.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function sanitizeElement(value: unknown): DesktopAnnotatorElement | null {
  const locator = sanitizeLocator(value);
  if (!locator || !isRecord(value)) return null;
  return {
    ...locator,
    attributes: map(value.attributes),
    styles: map(value.styles),
    width: Math.max(0, finite(value.width) ?? 0),
    height: Math.max(0, finite(value.height) ?? 0),
  };
}

/** What the page's main world said about the element's framework; null when nothing usable. */
export function sanitizeSourceIdentity(value: unknown): DesktopAnnotatorSource | null {
  if (!isRecord(value)) return null;
  const framework = text(value.framework, 32).toLowerCase();
  const components = list(value.components, MAX_SHORT);
  const file = text(value.file, 1000);
  const line = Math.max(0, Math.floor(finite(value.line) ?? 0));
  const column = Math.max(0, Math.floor(finite(value.column) ?? 0));
  if (!framework && components.length === 0 && !file) return null;
  return { framework, components, file, line: file ? line : 0, column: file ? column : 0 };
}

export type PageMessage =
  | { type: "ready"; url: string }
  | {
      type: "pick";
      token: string;
      url: string;
      title: string;
      rect: DesktopAnnotatorBox;
      viewport: DesktopAnnotatorViewport;
      elements: DesktopAnnotatorElement[];
      region: DesktopAnnotatorRegion | null;
    }
  | { type: "anchor"; rect: DesktopAnnotatorBox | null; viewport: DesktopAnnotatorViewport }
  | { type: "pin-click"; id: string }
  | { type: "pins"; url: string; missing: string[] }
  | { type: "escape" }
  | { type: "outside-click" };

/** One message the isolated-world script sent through its binding. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_PAGE_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "ready":
      return { type: "ready", url: text(value.url, MAX_URL) };
    case "pick": {
      const rect = sanitizeBox(value.rect);
      const viewport = sanitizeViewport(value.viewport);
      const elements = Array.isArray(value.elements) ? value.elements.slice(0, MAX_TARGETS).map(sanitizeElement) : [];
      // Every element or none: the element index is how main reads each one's source identity.
      if (!isId(value.token, MAX_TOKEN) || !rect || !viewport || elements.length === 0 || elements.some((element) => element === null)) return null;
      return {
        type: "pick",
        token: value.token,
        url: text(value.url, MAX_URL),
        title: text(value.title, MAX_SHORT),
        rect,
        viewport,
        elements: elements as DesktopAnnotatorElement[],
        region: sanitizeRegion(value.region),
      };
    }
    case "anchor": {
      const viewport = sanitizeViewport(value.viewport);
      if (!viewport) return null;
      return { type: "anchor", rect: sanitizeBox(value.rect), viewport };
    }
    case "pin-click":
      return isId(value.id) ? { type: "pin-click", id: value.id } : null;
    case "pins":
      return {
        type: "pins",
        url: text(value.url, MAX_URL),
        missing: Array.isArray(value.missing) ? value.missing.filter((id): id is string => isId(id)).slice(0, MAX_PINS) : [],
      };
    case "escape":
      return { type: "escape" };
    case "outside-click":
      return { type: "outside-click" };
    default:
      return null;
  }
}

/** The part of a rectangle inside the viewport; null when none of it is. */
export function clipToViewport(rect: DesktopAnnotatorBox, viewport: DesktopAnnotatorViewport): DesktopAnnotatorBox | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The element's rectangle, padded and clipped to the viewport, as fractions of the viewport — the
 * shape `cropRectInPixels` turns into pixels of the captured page (which handles the device pixel
 * ratio and the zoom). Null when nothing of the element is visible.
 */
export function elementCropFraction(rect: DesktopAnnotatorBox, viewport: DesktopAnnotatorViewport, padding = SCREENSHOT_PADDING): DesktopBrowserRect | null {
  const left = Math.max(0, rect.x - padding);
  const top = Math.max(0, rect.y - padding);
  const right = Math.min(viewport.width, rect.x + rect.width + padding);
  const bottom = Math.min(viewport.height, rect.y + rect.height + padding);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    width: (right - left) / viewport.width,
    height: (bottom - top) / viewport.height,
  };
}

/**
 * Where a pin goes, in viewport CSS pixels (its top-left corner). An element's pin sits outside its
 * top-right corner — right of it, vertically centred on the top edge — so it never covers the
 * element's content; without room on the right it moves above the corner. A region's pin is centred
 * on the region's top-left corner. Always kept inside the viewport.
 *
 * Also runs inside the page: the page script embeds this function's source, so it must stay
 * self-contained (no references outside its body, no syntax that compiles to helpers).
 */
export function annotatorPinPosition(
  rect: DesktopAnnotatorBox,
  viewport: DesktopAnnotatorViewport,
  width: number,
  height: number,
  region: boolean,
): { x: number; y: number } {
  const gap = 4;
  let x = rect.x + rect.width + gap;
  let y = rect.y - height / 2;
  if (region) {
    x = rect.x - width / 2;
    y = rect.y - height / 2;
  } else if (x + width > viewport.width - gap) {
    x = rect.x + rect.width - width;
    y = rect.y - height - gap;
  }
  x = Math.max(gap, Math.min(x, viewport.width - width - gap));
  y = Math.max(gap, Math.min(y, viewport.height - height - gap));
  return { x: x, y: y };
}
