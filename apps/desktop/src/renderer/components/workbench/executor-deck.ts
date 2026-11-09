import { snapCorner, type ExecutorCorner } from "@/components/workbench/executor-run";

/**
 * The executor card deck's motion (plan 20260930-executor-pip-motion): springs, the throw to a
 * corner, the carousel of several runs, deck-level hover and the expand morph.
 *
 * Every number here was tuned by hand in the demo archived next to the plan
 * (`wiki/plans/20260930-executor-pip-motion.demo.html`, its `DEFAULTS`); change a value there,
 * feel it, then carry it over.
 *
 * Per-frame motion bypasses React: `DeckController` writes transform, opacity, size and z-index
 * straight onto the elements from a `requestAnimationFrame` loop, and React renders card content
 * only. The loop stops once every spring has settled and restarts on the next input, so a pane
 * with a resting card burns no frames. Elements the loop animates must carry no React `style`.
 */

export const DECK_MOTION = {
  /** Return to a corner. */
  response: 0.42,
  damping: 0.8,
  /** Throw: iOS-style deceleration rate for the landing projection, and the velocity window. */
  decel: 0.997,
  velocityWindowMs: 80,
  /** Lift while dragged, and rubber-band resistance past the pane's edge. */
  grabScale: 1.03,
  rubber: true,
  /** Appear / disappear. */
  enterResponse: 0.32,
  enterDamping: 0.78,
  enterFrom: 0.88,
  /** Carousel: px shown per layer, scale lost per layer, tilt per layer (deg), per-card wobble (deg),
   * how much a card's content fades once it is behind the front one. */
  peek: 10,
  scaleStep: 0.06,
  tilt: 3,
  jitter: 1.5,
  backDim: 0.8,
  switchResponse: 0.36,
  switchDamping: 0.86,
  /** Expand morph: spring, backdrop dim, and the panel's inset from the pane. */
  expandResponse: 0.42,
  expandDamping: 0.88,
  dim: 0.25,
  inset: 24,
} as const;

/** Space between the deck and the pane's edges. */
export const DECK_MARGIN = 16;

/**
 * Extra room the bottom-right resting place leaves above the pane's dictation button (plan
 * 20261110-desktop-dictation D11), read from the `--dictation-clearance` custom property the pane
 * sets (inherited by the card layer's root). After the pane changes it, `refreshDeckClearance()`
 * moves every resting deck to its new place.
 */
export const DECK_CLEARANCE_PROPERTY = "--dictation-clearance";

const liveDecks = new Set<DeckController>();

export function refreshDeckClearance(): void {
  for (const deck of liveDecks) deck.clearanceChanged();
}
/** Peeking layers per side; deeper cards hide behind the last one. */
export const DECK_SIDE_DEPTH = 2;
/** Pointer slack around the deck's box, for the tilted corners. */
export const DECK_HOVER_SLACK = 8;

/** The collapsed card's geometry; the card's markup is built on these same numbers. */
export const CARD_WIDTH = 320;
export const CARD_HEADER_HEIGHT = 36;
export const CARD_LOG_LINE_HEIGHT = 18;
export const CARD_LOG_LINES = 4;
export const CARD_LOG_HEIGHT = CARD_LOG_LINE_HEIGHT * CARD_LOG_LINES;
export const CARD_LOG_BOTTOM = 10;
/** Header + log + its bottom gap + the 1 px border on each side; the measured height wins. */
export const CARD_HEIGHT = CARD_HEADER_HEIGHT + CARD_LOG_HEIGHT + CARD_LOG_BOTTOM + 2;
/** Where the log starts inside the card (below the top border and the header), and its centre:
 * the switch arrows sit on it, the edge fades cover it. */
export const CARD_LOG_TOP = 1 + CARD_HEADER_HEIGHT;
export const CARD_LOG_CENTER = CARD_LOG_TOP + CARD_LOG_HEIGHT / 2;

/** A press that moved less than this is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Fixed integration substep. */
const STEP = 1 / 240;
/** The grab lift's own spring. */
const GRAB_RESPONSE = 0.25;
const GRAB_DAMPING = 0.7;

/**
 * A damped harmonic oscillator of unit mass, parameterised like SwiftUI's spring: `response` is the
 * period in seconds, `dampingRatio` below 1 overshoots, 1 is critical.
 */
export class Spring {
  x: number;
  v = 0;
  target: number;
  private readonly eps: number;

  constructor(value: number, eps: number) {
    this.x = value;
    this.target = value;
    this.eps = eps;
  }

  step(dt: number, response: number, dampingRatio: number): void {
    const k = ((2 * Math.PI) / response) ** 2;
    const c = (4 * Math.PI * dampingRatio) / response;
    const a = -k * (this.x - this.target) - c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }

  get settled(): boolean {
    return Math.abs(this.x - this.target) < this.eps && Math.abs(this.v) < this.eps * 10;
  }

  get atRest(): boolean {
    return this.v === 0 && this.x === this.target;
  }

  snap(): void {
    this.x = this.target;
    this.v = 0;
  }
}

/** Seconds of release velocity carried into the landing point: the iOS projection
 * `v × decel / (1 − decel) / 1000`. */
export function projectionSeconds(decel: number = DECK_MOTION.decel): number {
  return decel / (1 - decel) / 1000;
}

/** A card's signed place in the carousel: the front is 0, `order[1]` is +1 (peeking on the right),
 * the last is −1 (on the left); the rest alternate outward. */
export function carouselPosition(index: number, count: number): number {
  return index <= count / 2 ? index : index - count;
}

/** How many layers peek out on each side of the front card. */
export function deckSides(count: number): { left: number; right: number } {
  const n = Math.max(count, 1);
  const right = Math.min(Math.floor(n / 2), DECK_SIDE_DEPTH);
  const left = Math.min(n - 1 - Math.floor(n / 2), DECK_SIDE_DEPTH);
  return { left, right };
}

/** Rubber-band resistance: 1:1 inside [min, max], ever stiffer past it. */
export function rubberBand(value: number, min: number, max: number, dimension: number): number {
  if (!DECK_MOTION.rubber || dimension <= 0) return value;
  const resist = (distance: number) => (1 - 1 / ((distance * 0.55) / dimension + 1)) * dimension;
  if (value < min) return min - resist(min - value);
  if (value > max) return max + resist(value - max);
  return value;
}

/** A fixed pseudo-random value in [-1, 1] per run, so a card's casual angle never changes. */
export function wobble(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
  const x = Math.sin(hash * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

type Rect = { x: number; y: number; w: number; h: number };

type CardMotion = {
  el: HTMLElement | null;
  content: HTMLElement | null;
  mini: HTMLElement | null;
  enter: Spring;
  depth: Spring;
  fade: Spring;
  wobble: number;
  leaving: boolean;
  goneReported: boolean;
  height: number;
};

type Drag = {
  pointerId: number;
  runId: string;
  target: HTMLElement;
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
  samples: { t: number; x: number; y: number }[];
};

export type DeckCallbacks = {
  /** A click on a peeking card. */
  bringToFront: (runId: string) => void;
  /** A click on the front card. */
  expand: (runId: string) => void;
  cornerChanged: (corner: ExecutorCorner) => void;
  /** A leaving card finished springing out. */
  gone: (runId: string) => void;
  /** A collapsing panel is back in its slot. */
  panelClosed: (runId: string) => void;
};

export type DeckSync = {
  /** Present runs, front first. */
  order: readonly string[];
  /** Runs springing out. */
  leaving: readonly string[];
  /** The run whose card is expanded or still shrinking back, and whether it is open. */
  panel: { runId: string; open: boolean } | null;
};

const NOOP_CALLBACKS: DeckCallbacks = {
  bringToFront: () => {},
  expand: () => {},
  cornerChanged: () => {},
  gone: () => {},
  panelClosed: () => {},
};

/**
 * The deck's motion and interaction state, and the loop that writes it to the DOM. One per pane.
 * React tells it which runs exist and in what order (`sync`), hands it the elements through the
 * ref callbacks, and forwards the card's pointer events; it reports discrete outcomes back through
 * `DeckCallbacks`.
 */
export class DeckController {
  private callbacks: DeckCallbacks = NOOP_CALLBACKS;
  private root: HTMLElement | null = null;
  private deckEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private readonly cards = new Map<string, CardMotion>();
  private readonly cardRefs = new Map<string, (el: HTMLElement | null) => void>();
  private order: string[] = [];
  private corner: ExecutorCorner;
  // The deck's (x, y) is the top-left of its bounding box inside the pane.
  private readonly x = new Spring(0, 0.05);
  private readonly y = new Spring(0, 0.05);
  private readonly scale = new Spring(1, 0.0005);
  private drag: Drag | null = null;
  private placed = false;
  private pane = { w: 0, h: 0 };
  /** The pointer in pane coordinates, null when it is outside the pane or the window. */
  private pointer: { x: number; y: number } | null = null;
  private readonly panel = { p: new Spring(0, 0.0005), runId: null as string | null, open: false, closed: false };
  private flags = { hover: false, switching: false, lifted: false };
  private raf = 0;
  private last = 0;
  private acc = 0;
  private resize: ResizeObserver | null = null;
  private readonly reduced: MediaQueryList | null =
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  constructor(corner: ExecutorCorner) {
    this.corner = corner;
  }

  setCallbacks(callbacks: DeckCallbacks): void {
    this.callbacks = callbacks;
  }

  /* ---------------------------------------------------------------- elements */

  /** The card layer's root: the pane's box, used for size and pointer coordinates. */
  readonly attachRoot = (el: HTMLElement | null): void => {
    if (el === this.root) return;
    if (this.root) this.detachRoot();
    if (!el) return;
    this.root = el;
    liveDecks.add(this);
    this.resize = new ResizeObserver(this.onResize);
    this.resize.observe(el);
    window.addEventListener("pointermove", this.onWindowPointerMove, { passive: true });
    window.addEventListener("blur", this.onPointerGone);
    document.documentElement.addEventListener("pointerleave", this.onPointerGone);
    this.refreshPane();
  };

  /** The deck container: carries the hover/switch/lifted data attributes the CSS keys on. */
  readonly attachDeck = (el: HTMLElement | null): void => {
    this.deckEl = el;
    this.flags = { hover: false, switching: false, lifted: false };
    if (el) {
      this.render();
      this.kick();
    } else {
      this.stopLoop();
    }
  };

  readonly attachOverlay = (el: HTMLElement | null): void => {
    this.overlayEl = el;
    if (el) this.render();
  };

  readonly attachBackdrop = (el: HTMLElement | null): void => {
    this.backdropEl = el;
    if (el) this.render();
  };

  /** A stable ref callback per run. */
  cardRef(runId: string): (el: HTMLElement | null) => void {
    let ref = this.cardRefs.get(runId);
    if (!ref) {
      ref = (el) => {
        // Detaching must not resurrect a card the deck already dropped.
        const card = el ? this.ensureCard(runId) : this.cards.get(runId);
        if (!card) return;
        card.el = el;
        card.content = el?.querySelector<HTMLElement>('[data-deck-part="content"]') ?? null;
        card.mini = el?.querySelector<HTMLElement>('[data-deck-part="mini"]') ?? null;
        if (el && this.panel.runId !== runId && el.offsetHeight > 0) card.height = el.offsetHeight;
        if (el) this.render();
      };
      this.cardRefs.set(runId, ref);
    }
    return ref;
  }

  private detachRoot(): void {
    this.resize?.disconnect();
    this.resize = null;
    window.removeEventListener("pointermove", this.onWindowPointerMove);
    window.removeEventListener("blur", this.onPointerGone);
    document.documentElement.removeEventListener("pointerleave", this.onPointerGone);
    this.root = null;
    liveDecks.delete(this);
    this.pointer = null;
    this.pane = { w: 0, h: 0 };
    this.placed = false;
    this.endDrag();
    this.stopLoop();
  }

  /** The pane's dictation clearance changed: a deck resting bottom-right springs to its new place. */
  clearanceChanged(): void {
    if (!this.visible() || !this.placed || this.drag) return;
    this.retarget();
    this.render();
    this.kick();
  }

  /* ---------------------------------------------------------------- React → deck */

  sync(next: DeckSync): void {
    for (const id of next.order) {
      const card = this.ensureCard(id);
      if (card.leaving) {
        card.leaving = false;
        card.goneReported = false;
      }
      card.enter.target = 1;
    }
    for (const id of next.leaving) {
      const card = this.ensureCard(id);
      card.leaving = true;
      card.enter.target = 0;
    }
    const keep = new Set([...next.order, ...next.leaving]);
    for (const id of [...this.cards.keys()]) {
      if (keep.has(id)) continue;
      this.cards.delete(id);
      this.cardRefs.delete(id);
    }

    const orderChanged = next.order.length !== this.order.length || next.order.some((id, index) => id !== this.order[index]);
    if (orderChanged) {
      this.order = [...next.order];
      this.retarget();
    }

    const panelRunId = next.panel?.runId ?? null;
    if (panelRunId !== this.panel.runId) {
      if (this.panel.runId !== null) this.clearPanelStyles(this.panel.runId);
      this.panel.runId = panelRunId;
      this.panel.p.x = 0;
      this.panel.p.v = 0;
      this.panel.closed = false;
    }
    const open = next.panel?.open ?? false;
    if (open && !this.panel.open) {
      this.panel.closed = false;
      this.endDrag();
    }
    this.panel.open = open;
    this.panel.p.target = open ? 1 : 0;

    this.refreshPane();
    this.render();
    this.kick();
  }

  private ensureCard(id: string): CardMotion {
    let card = this.cards.get(id);
    if (!card) {
      card = {
        el: null,
        content: null,
        mini: null,
        // A new run lands on the front and springs in from a slightly smaller, transparent card.
        enter: new Spring(0, 0.001),
        depth: new Spring(0, 0.001),
        fade: new Spring(1, 0.001),
        wobble: wobble(id),
        leaving: false,
        goneReported: false,
        height: 0,
      };
      card.enter.target = 1;
      this.cards.set(id, card);
    }
    return card;
  }

  /* ---------------------------------------------------------------- geometry */

  private cardHeight(): number {
    const front = this.order[0] !== undefined ? this.cards.get(this.order[0]) : undefined;
    return front && front.height > 0 ? front.height : CARD_HEIGHT;
  }

  private deckSize(): { w: number; h: number; leftExtent: number } {
    const sides = deckSides(this.order.length);
    return {
      w: CARD_WIDTH + DECK_MOTION.peek * (sides.left + sides.right),
      h: this.cardHeight(),
      leftExtent: DECK_MOTION.peek * sides.left,
    };
  }

  private cornerTarget(corner: ExecutorCorner): { x: number; y: number } {
    const deck = this.deckSize();
    const clearance = corner === "bottom-right" ? this.clearance() : 0;
    return {
      x: corner.endsWith("left") ? DECK_MARGIN : this.pane.w - deck.w - DECK_MARGIN,
      y: corner.startsWith("top") ? DECK_MARGIN : this.pane.h - deck.h - DECK_MARGIN - clearance,
    };
  }

  private clearance(): number {
    if (!this.root) return 0;
    const value = Number.parseFloat(getComputedStyle(this.root).getPropertyValue(DECK_CLEARANCE_PROPERTY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private visible(): boolean {
    return this.pane.w > 0 && this.pane.h > 0;
  }

  private retarget(): void {
    if (this.visible()) {
      const target = this.cornerTarget(this.corner);
      this.x.target = target.x;
      this.y.target = target.y;
    }
    const n = this.order.length;
    this.order.forEach((id, index) => {
      const card = this.cards.get(id);
      if (!card) return;
      const target = carouselPosition(index, n);
      // Wrapping around (the leftmost becoming the rightmost, or back) would sweep the card across
      // the front one; instead it re-enters from just outside its new side, fading in.
      if (Math.abs(target - card.depth.target) > 1.5) {
        card.depth.x = target + Math.sign(target);
        card.depth.v = 0;
        card.fade.x = 0;
        card.fade.v = 0;
      }
      card.depth.target = target;
    });
  }

  /** Puts the deck on its corner at once: the first card, or a pane coming back from hidden. */
  private place(): void {
    if (this.order.length === 0 || !this.visible()) return;
    this.retarget();
    this.x.snap();
    this.y.snap();
    this.placed = true;
  }

  /**
   * Reads the pane's size. A hidden pane (an inactive tab is `display:none`, so 0×0) never
   * retargets the deck; when its size comes back the deck is placed on its corner immediately
   * instead of flying in from wherever a 0×0 pane would have put it.
   */
  private refreshPane(): void {
    if (!this.root) return;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const wasHidden = !this.visible();
    const changed = w !== this.pane.w || h !== this.pane.h;
    this.pane = { w, h };
    if (!this.visible()) return;
    if (wasHidden || !this.placed) {
      this.place();
      return;
    }
    if (!changed || this.drag) return;
    // A deck at rest stays glued to its corner while the pane resizes; one in flight retargets.
    const atRest = this.x.settled && this.y.settled;
    this.retarget();
    if (atRest) {
      this.x.snap();
      this.y.snap();
    }
  }

  private readonly onResize = (): void => {
    this.refreshPane();
    this.render();
    this.kick();
  };

  /* ---------------------------------------------------------------- pointer */

  private local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.root?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  }

  /** Deck hover is judged against the pointer, never `:hover`: the card layer is
   * pointer-events-none and cards slide under a still pointer. */
  private readonly onWindowPointerMove = (event: PointerEvent): void => {
    if (!this.root) return;
    const rect = this.root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.pointer = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
    this.writeFlags();
  };

  private readonly onPointerGone = (): void => {
    this.pointer = null;
    this.writeFlags();
  };

  pointerDown(event: PointerEvent, target: HTMLElement, runId: string): void {
    if (event.button !== 0 || this.drag || this.panel.runId !== null) return;
    const card = this.cards.get(runId);
    if (!card || card.leaving || !this.order.includes(runId)) return;
    const p = this.local(event);
    // Grab wherever the deck is right now, mid-flight included: its spring is interrupted.
    this.drag = {
      pointerId: event.pointerId,
      runId,
      target,
      grabX: p.x - this.x.x,
      grabY: p.y - this.y.x,
      startX: p.x,
      startY: p.y,
      moved: false,
      samples: [{ t: performance.now(), x: this.x.x, y: this.y.x }],
    };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; the drag simply ends on the next up/cancel.
    }
    this.kick();
  }

  pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const p = this.local(event);
    if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < CLICK_SLOP_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      this.scale.target = DECK_MOTION.grabScale;
    }
    const deck = this.deckSize();
    const x = rubberBand(p.x - drag.grabX, 0, this.pane.w - deck.w, this.pane.w);
    const y = rubberBand(p.y - drag.grabY, 0, this.pane.h - deck.h, this.pane.h);
    this.x.x = x;
    this.y.x = y;
    const now = performance.now();
    drag.samples.push({ t: now, x, y });
    while (drag.samples.length > 2 && now - drag.samples[0]!.t > DECK_MOTION.velocityWindowMs) drag.samples.shift();
    this.render();
    this.kick();
  }

  pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const velocity = this.velocity(drag);
    this.endDrag();
    if (!drag.moved) {
      // A click: a peeking card comes to the front, the front card expands.
      const index = this.order.indexOf(drag.runId);
      if (index > 0) this.callbacks.bringToFront(drag.runId);
      else if (index === 0) this.callbacks.expand(drag.runId);
      return;
    }
    // The landing point is where the deck is plus how far the throw would carry it.
    const deck = this.deckSize();
    const k = projectionSeconds();
    const corner = snapCorner(
      { x: this.x.x + deck.w / 2 + velocity.vx * k, y: this.y.x + deck.h / 2 + velocity.vy * k },
      { width: this.pane.w, height: this.pane.h },
    );
    if (corner !== this.corner) {
      this.corner = corner;
      this.callbacks.cornerChanged(corner);
    }
    this.retarget();
    // Hand the pointer's velocity to the spring: the deck keeps moving the way it was thrown.
    this.x.v = velocity.vx;
    this.y.v = velocity.vy;
    this.kick();
  }

  pointerCancel(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.endDrag();
    this.retarget();
    this.kick();
  }

  private velocity(drag: Drag): { vx: number; vy: number } {
    const now = performance.now();
    const samples = drag.samples.filter((sample) => now - sample.t <= DECK_MOTION.velocityWindowMs);
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const a = samples[0]!;
    const b = samples[samples.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.scale.target = 1;
    this.kick();
  }

  /* ---------------------------------------------------------------- loop */

  private kick(): void {
    if (this.raf !== 0 || !this.deckEl) return;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private springs(): Spring[] {
    const all = [this.scale, this.panel.p];
    for (const card of this.cards.values()) all.push(card.enter, card.depth, card.fade);
    return all;
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const dragging = this.drag !== null;
    if (this.reduced?.matches) {
      // Reduced motion: every spring lands on its target at once.
      for (const spring of this.springs()) spring.snap();
      if (!dragging) {
        this.x.snap();
        this.y.snap();
      }
    } else {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.acc -= STEP;
        if (!dragging) {
          this.x.step(STEP, DECK_MOTION.response, DECK_MOTION.damping);
          this.y.step(STEP, DECK_MOTION.response, DECK_MOTION.damping);
        }
        this.scale.step(STEP, GRAB_RESPONSE, GRAB_DAMPING);
        this.panel.p.step(STEP, DECK_MOTION.expandResponse, DECK_MOTION.expandDamping);
        for (const card of this.cards.values()) {
          card.enter.step(STEP, DECK_MOTION.enterResponse, DECK_MOTION.enterDamping);
          card.depth.step(STEP, DECK_MOTION.switchResponse, DECK_MOTION.switchDamping);
          card.fade.step(STEP, DECK_MOTION.switchResponse, 1);
        }
      }
    }
    this.settle();
    this.render();
    if (!this.idle()) this.raf = requestAnimationFrame(this.frame);
  };

  private settle(): void {
    if (!this.drag) {
      if (this.x.settled) this.x.snap();
      if (this.y.settled) this.y.snap();
    }
    for (const spring of this.springs()) if (spring.settled) spring.snap();
    for (const [id, card] of this.cards) {
      if (!card.leaving || card.goneReported) continue;
      if (card.enter.x < 0.02 && Math.abs(card.enter.v) < 0.05) {
        card.enter.snap();
        card.goneReported = true;
        this.callbacks.gone(id);
      }
    }
    const panel = this.panel;
    if (panel.runId !== null && !panel.open && !panel.closed && panel.p.x < 0.004) {
      // Back in its slot: hand the stage back to the card.
      panel.p.snap();
      panel.closed = true;
      this.clearPanelStyles(panel.runId);
      this.callbacks.panelClosed(panel.runId);
    }
  }

  private idle(): boolean {
    if (!this.drag && !(this.x.atRest && this.y.atRest)) return false;
    return this.springs().every((spring) => spring.atRest);
  }

  /* ---------------------------------------------------------------- render */

  private panelShown(): boolean {
    return this.panel.runId !== null && !this.panel.closed;
  }

  private render(): void {
    if (!this.deckEl) return;
    const W = CARD_WIDTH;
    const H = this.cardHeight();
    const deck = this.deckSize();
    const frontX = this.x.x + deck.leftExtent;
    const lifted = this.drag?.moved === true;
    const panelOut = this.panelShown() ? clamp(this.panel.p.x, 0, 1) : 0;

    for (const [id, card] of this.cards) {
      const el = card.el;
      if (!el) continue;
      const r = card.depth.x;
      const d = Math.abs(r);
      const layer = clamp(d, 0, DECK_SIDE_DEPTH);
      // Each layer out shrinks a little, stays vertically centred on the front card and shows
      // `peek` px of its outer edge: the right edge for cards on the right, the left for the left.
      const layerScale = 1 - DECK_MOTION.scaleStep * layer;
      const x0 = r >= 0 ? frontX + W + DECK_MOTION.peek * layer - W * layerScale : frontX - DECK_MOTION.peek * layer;
      const y0 = this.y.x + (H * (1 - layerScale)) / 2;
      // The slot the panel grows out of and shrinks back into (untilted).
      const slot: Rect = { x: x0, y: y0, w: W * layerScale, h: H * layerScale };

      if (this.panelShown() && id === this.panel.runId) {
        this.renderPanel(card, el, slot);
        continue;
      }

      // Enter/exit and the grab lift scale about the card's own centre.
      const enter = Math.max(0, card.enter.x);
      const s = layerScale * this.scale.x * (DECK_MOTION.enterFrom + (1 - DECK_MOTION.enterFrom) * enter);
      const cx = x0 + (W * layerScale) / 2;
      const cy = y0 + (H * layerScale) / 2;
      // A loosely stacked deck: cards on the right lean clockwise, on the left anticlockwise, each a
      // little more per layer, plus a small fixed per-card wobble. The front card is always straight.
      const angle = Math.sign(r) * DECK_MOTION.tilt * layer + DECK_MOTION.jitter * card.wobble * clamp(d, 0, 1);
      el.style.transformOrigin = "50% 50%";
      el.style.transform = `translate3d(${cx - W / 2}px, ${cy - H / 2}px, 0) rotate(${angle}deg) scale(${s})`;
      // While a panel is out, the rest of the deck steps away.
      el.style.opacity = String(
        clamp(enter, 0, 1) * clamp(DECK_SIDE_DEPTH + 1 - d, 0, 1) * clamp(card.fade.x, 0, 1) * (1 - panelOut),
      );
      el.style.zIndex = String(1000 - Math.round(d * 100));
      if (card.content) card.content.style.opacity = String(1 - DECK_MOTION.backDim * clamp(d, 0, 1));
    }

    // The switch overlay sits exactly over the front slot and follows the grab lift.
    if (this.overlayEl) {
      this.overlayEl.style.height = `${H}px`;
      this.overlayEl.style.transform = `translate3d(${frontX}px, ${this.y.x}px, 0) scale(${this.scale.x})`;
    }
    if (this.backdropEl) this.backdropEl.style.opacity = String(DECK_MOTION.dim * panelOut);
    this.writeFlags();
  }

  /** Expanding morphs the card itself: its rect goes from the slot to the panel's, on a spring. */
  private renderPanel(card: CardMotion, el: HTMLElement, from: Rect): void {
    const p = this.panel.p.x;
    const q = clamp(p, 0, 1);
    const inset = DECK_MOTION.inset;
    const to: Rect = { x: inset, y: inset, w: this.pane.w - 2 * inset, h: this.pane.h - 2 * inset };
    const lerp = (a: number, b: number) => a + (b - a) * p;
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate3d(${lerp(from.x, to.x)}px, ${lerp(from.y, to.y)}px, 0)`;
    el.style.width = `${Math.max(40, lerp(from.w, to.w))}px`;
    el.style.height = `${Math.max(CARD_HEADER_HEIGHT, lerp(from.h, to.h))}px`;
    el.style.opacity = "1";
    el.style.zIndex = "2000";
    if (card.content) card.content.style.opacity = "1";
    // The card's own rolling log stays for the first moments so the content does not blink, at its
    // collapsed width so it does not re-truncate while the panel grows.
    if (card.mini) {
      card.mini.style.width = `${CARD_WIDTH - 2}px`;
      card.mini.style.opacity = String(clamp(1 - p / 0.25, 0, 1));
    }
    const divider = el.querySelector<HTMLElement>('[data-deck-part="divider"]');
    if (divider) divider.style.opacity = String(q);
    // The full transcript is laid out at the panel's final size from the start, so it never
    // reflows while the panel grows; it fades in once there is room for it.
    const body = el.querySelector<HTMLElement>('[data-deck-part="body"]');
    if (body) {
      body.style.width = `${Math.max(0, to.w - 2)}px`;
      body.style.height = `${Math.max(0, to.h - 2 - CARD_LOG_TOP)}px`;
      body.style.opacity = String(clamp((p - 0.35) / 0.45, 0, 1));
      body.style.pointerEvents = this.panel.open ? "auto" : "none";
    }
  }

  private clearPanelStyles(runId: string): void {
    const card = this.cards.get(runId);
    const el = card?.el;
    if (!card || !el) return;
    el.style.width = "";
    el.style.height = "";
    if (card.mini) {
      card.mini.style.width = "";
      card.mini.style.opacity = "";
    }
  }

  /** Deck-level hover, re-evaluated on pointer events and on every frame (the deck moves under a
   * still pointer). */
  private writeFlags(): void {
    const el = this.deckEl;
    if (!el) return;
    let hover = false;
    if (this.pointer && this.order.length > 0 && this.panel.runId === null && this.visible()) {
      const deck = this.deckSize();
      const { x, y } = this.pointer;
      hover =
        x >= this.x.x - DECK_HOVER_SLACK &&
        x <= this.x.x + deck.w + DECK_HOVER_SLACK &&
        y >= this.y.x - DECK_HOVER_SLACK &&
        y <= this.y.x + deck.h + DECK_HOVER_SLACK;
    }
    const lifted = this.drag?.moved === true;
    // The switch arrows and edge fades: hovering, not dragging, and more than one run.
    const switching = hover && !lifted && this.order.length > 1;
    const next = { hover, switching, lifted };
    const set = (name: string, on: boolean) => {
      if (on) el.setAttribute(name, "");
      else el.removeAttribute(name);
    };
    if (next.hover !== this.flags.hover) set("data-hover", next.hover);
    if (next.switching !== this.flags.switching) set("data-switch", next.switching);
    if (next.lifted !== this.flags.lifted) set("data-lifted", next.lifted);
    this.flags = next;
  }
}
