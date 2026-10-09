import type { NativeImage, WebContents } from "electron";

import type { DesktopAnnotatorBox, DesktopAnnotatorSource, DesktopAnnotatorState, DesktopAnnotatorViewport, DesktopBrowserEvent } from "../shared/desktop-bridge";
import {
  annotatorStateNeedsPage,
  clipToViewport,
  elementCropFraction,
  parsePageMessage,
  sanitizeSourceIdentity,
  SCREENSHOT_PADDING,
  type PageMessage,
} from "./browser-annotator-policy";
import { ANNOTATOR_BINDING, ANNOTATOR_PAGE_SCRIPT, ANNOTATOR_WORLD, SOURCE_IDENTITY_READER } from "./browser-annotator-page";
import { cropRectInPixels } from "./browser-policy";

/**
 * Browser annotations, main-process half (plan 20260929-browser-annotations): instruments page
 * guests over CDP (`webContents.debugger`) on demand.
 *
 * - The page script lives in a named isolated world: registered with
 *   `Page.addScriptToEvaluateOnNewDocument` (so it survives navigations) and run into the current
 *   document at attach. Its only channel to main is a `Runtime.addBinding` binding exposed to
 *   contexts of that world's name — page scripts see neither.
 * - Framework source identity is read by main in the page's **main** world, on each node the
 *   isolated world picked (`DOM.describeNode` → `DOM.resolveNode` → `Runtime.callFunctionOn`), so no
 *   request/response handshake is ever exposed to page scripts. All elements of one pick share one
 *   time budget.
 * - The screenshot — of the picked elements' union, or of a dragged region, clipped to the
 *   viewport — is the guest's `capturePage` cropped with `cropRectInPixels`, the same path as
 *   框选截图 (device pixel ratio and zoom handled there).
 * - Only the top-level frame is instrumented; the guest keeps no preload.
 *
 * Lifetimes follow the guest (its webContents id), never the tab: a re-created guest is a new
 * entry that attaches again. The debugger is attached only after the guest has a frame (attaching to
 * a guest that never loaded hangs `Page.enable`), every command is bounded by a timeout, and a
 * detach while the guest lives — for example if DevTools take the target over — is followed by a
 * bounded number of re-attach attempts, reported to the renderer as `annotator-status`.
 */

const COMMAND_TIMEOUT_MS = 3000;
/** One budget for reading the source identity of every element of a pick. */
const SOURCE_BUDGET_MS = 1500;
const CAPTURE_TIMEOUT_MS = 2500;
const REATTACH_DELAY_MS = 600;
const REATTACH_LIMIT = 5;
/** Screenshots wider than this are scaled down; larger than the byte budget become JPEG. */
const SCREENSHOT_MAX_WIDTH = 1600;
const SCREENSHOT_PNG_BUDGET = 1_500_000;

type ContextInfo = { frameId: string; name: string; isDefault: boolean };

type Instrument = {
  contents: WebContents;
  /** The renderer's latest wish; re-applied after every navigation. */
  desired: DesktopAnnotatorState;
  hasFrame: boolean;
  attached: boolean;
  attaching: Promise<boolean> | null;
  mainFrameId: string | null;
  contexts: Map<number, ContextInfo>;
  reattachAttempts: number;
  reattachTimer: ReturnType<typeof setTimeout> | null;
  available: boolean;
  onMessage: (event: unknown, method: string, params: unknown) => void;
  onDetach: (event: unknown, reason: string) => void;
  disposed: boolean;
};

export type BrowserAnnotator = {
  /** A page guest was adopted: start tracking whether it has a frame. */
  adopt: (contents: WebContents) => void;
  /** The renderer's wish for a page guest. */
  sync: (contents: WebContents, state: DesktopAnnotatorState) => void;
  /** DevTools of the guest closed: a take-over may have ended, try again now. */
  retry: (contents: WebContents) => void;
  forget: (id: number) => void;
  reset: () => void;
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const EMPTY_STATE: DesktopAnnotatorState = { mode: false, capture: false, pins: [], anchor: null, outlined: [] };

export function createBrowserAnnotator(options: {
  send: (event: DesktopBrowserEvent) => void;
  log: (message: string, detail?: unknown) => void;
}): BrowserAnnotator {
  const instruments = new Map<number, Instrument>();

  function command<T = unknown>(entry: Instrument, method: string, params?: Record<string, unknown>, ms = COMMAND_TIMEOUT_MS): Promise<T> {
    if (entry.contents.isDestroyed() || !entry.contents.debugger.isAttached()) return Promise.reject(new Error("debugger not attached"));
    return withTimeout(entry.contents.debugger.sendCommand(method, params) as Promise<T>, ms, method);
  }

  function contextOf(entry: Instrument, world: boolean): number | null {
    for (const [id, info] of entry.contexts) {
      if (info.frameId !== entry.mainFrameId) continue;
      if (world ? info.name === ANNOTATOR_WORLD && !info.isDefault : info.isDefault) return id;
    }
    return null;
  }

  function setAvailable(entry: Instrument, available: boolean): void {
    if (entry.available === available) return;
    entry.available = available;
    options.send({ kind: "annotator-status", guestId: entry.contents.id, available });
  }

  function entryFor(contents: WebContents): Instrument {
    let entry = instruments.get(contents.id);
    if (entry) return entry;
    const created: Instrument = {
      contents,
      desired: EMPTY_STATE,
      hasFrame: false,
      attached: false,
      attaching: null,
      mainFrameId: null,
      contexts: new Map(),
      reattachAttempts: 0,
      reattachTimer: null,
      available: true,
      disposed: false,
      onMessage: (_event, method, params) => onMessage(created, method, params),
      onDetach: (_event, reason) => onDetach(created, reason),
    };
    entry = created;
    instruments.set(contents.id, entry);
    return entry;
  }

  function adopt(contents: WebContents): void {
    const entry = entryFor(contents);
    // A guest attaches on about:blank before any navigation; the first dom-ready means it has a
    // frame the debugger can attach to without hanging.
    const ready = () => {
      if (entry.disposed) return;
      entry.hasFrame = true;
      if (annotatorStateNeedsPage(entry.desired)) void ensure(entry);
    };
    contents.on("dom-ready", ready);
    contents.once("destroyed", () => forget(contents.id));
  }

  async function ensure(entry: Instrument): Promise<boolean> {
    if (entry.disposed || entry.contents.isDestroyed()) return false;
    if (entry.attached) return true;
    if (!entry.hasFrame) return false;
    if (entry.attaching) return entry.attaching;
    entry.attaching = attach(entry).finally(() => {
      entry.attaching = null;
    });
    return entry.attaching;
  }

  async function attach(entry: Instrument): Promise<boolean> {
    const dbg = entry.contents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
    } catch (error) {
      options.log("浏览器批注：无法附加调试器", String(error));
      setAvailable(entry, false);
      scheduleReattach(entry);
      return false;
    }
    dbg.removeListener("message", entry.onMessage);
    dbg.removeListener("detach", entry.onDetach);
    dbg.on("message", entry.onMessage);
    dbg.on("detach", entry.onDetach);
    entry.attached = true;
    entry.contexts.clear();
    try {
      await command(entry, "Runtime.enable");
      await command(entry, "Page.enable");
      const tree = record(await command(entry, "Page.getFrameTree"));
      entry.mainFrameId = String(record(record(tree.frameTree).frame).id ?? "") || null;
      await command(entry, "Runtime.addBinding", { name: ANNOTATOR_BINDING, executionContextName: ANNOTATOR_WORLD });
      await command(entry, "Page.addScriptToEvaluateOnNewDocument", { source: ANNOTATOR_PAGE_SCRIPT, worldName: ANNOTATOR_WORLD, runImmediately: true });
      // Older engines ignore runImmediately: create the world in the current document ourselves.
      if (contextOf(entry, true) === null && entry.mainFrameId) {
        const created = record(
          await command(entry, "Page.createIsolatedWorld", { frameId: entry.mainFrameId, worldName: ANNOTATOR_WORLD, grantUniveralAccess: false }),
        );
        const contextId = typeof created.executionContextId === "number" ? created.executionContextId : null;
        if (contextId !== null) {
          if (!entry.contexts.has(contextId)) entry.contexts.set(contextId, { frameId: entry.mainFrameId, name: ANNOTATOR_WORLD, isDefault: false });
          await command(entry, "Runtime.evaluate", { expression: ANNOTATOR_PAGE_SCRIPT, contextId, silent: true });
        }
      }
      entry.reattachAttempts = 0;
      setAvailable(entry, true);
      await apply(entry);
      return true;
    } catch (error) {
      options.log("浏览器批注：页面注入失败", String(error));
      setAvailable(entry, false);
      detach(entry);
      scheduleReattach(entry);
      return false;
    }
  }

  function detach(entry: Instrument): void {
    const dbg = entry.contents.isDestroyed() ? null : entry.contents.debugger;
    entry.attached = false;
    entry.contexts.clear();
    if (!dbg) return;
    dbg.removeListener("message", entry.onMessage);
    dbg.removeListener("detach", entry.onDetach);
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // Already gone.
    }
  }

  function onDetach(entry: Instrument, reason: string): void {
    entry.attached = false;
    entry.contexts.clear();
    if (entry.disposed || entry.contents.isDestroyed()) return;
    options.log("浏览器批注：调试器被断开", reason);
    setAvailable(entry, false);
    scheduleReattach(entry);
  }

  function scheduleReattach(entry: Instrument): void {
    if (entry.reattachTimer !== null || entry.disposed || entry.contents.isDestroyed()) return;
    if (!annotatorStateNeedsPage(entry.desired)) return;
    if (entry.reattachAttempts >= REATTACH_LIMIT) return;
    entry.reattachAttempts += 1;
    entry.reattachTimer = setTimeout(() => {
      entry.reattachTimer = null;
      if (annotatorStateNeedsPage(entry.desired)) void ensure(entry);
    }, REATTACH_DELAY_MS * entry.reattachAttempts);
  }

  async function evaluateInWorld(entry: Instrument, expression: string): Promise<unknown> {
    const contextId = contextOf(entry, true);
    if (contextId === null) return undefined;
    const result = record(await command(entry, "Runtime.evaluate", { expression, contextId, returnByValue: true, silent: true }));
    return record(result.result).value;
  }

  async function apply(entry: Instrument): Promise<void> {
    if (!entry.attached) return;
    const payload = JSON.stringify(entry.desired);
    await evaluateInWorld(entry, `globalThis.__cofluxAnnotatorApi && globalThis.__cofluxAnnotatorApi.apply(${payload})`).catch((error: unknown) =>
      options.log("浏览器批注：同步页面状态失败", String(error)),
    );
  }

  function sync(contents: WebContents, state: DesktopAnnotatorState): void {
    const entry = entryFor(contents);
    entry.desired = state;
    if (entry.attached) {
      void apply(entry);
      return;
    }
    if (!annotatorStateNeedsPage(state)) return;
    // A wish from the user resets the retry budget.
    entry.reattachAttempts = 0;
    void ensure(entry);
  }

  function onMessage(entry: Instrument, method: string, raw: unknown): void {
    const params = record(raw);
    switch (method) {
      case "Runtime.executionContextCreated": {
        const context = record(params.context);
        const aux = record(context.auxData);
        if (typeof context.id !== "number") return;
        entry.contexts.set(context.id, {
          frameId: typeof aux.frameId === "string" ? aux.frameId : "",
          name: typeof context.name === "string" ? context.name : "",
          isDefault: aux.isDefault === true,
        });
        return;
      }
      case "Runtime.executionContextDestroyed":
        if (typeof params.executionContextId === "number") entry.contexts.delete(params.executionContextId);
        return;
      case "Runtime.executionContextsCleared":
        entry.contexts.clear();
        return;
      case "Page.frameNavigated": {
        const frame = record(params.frame);
        if (!frame.parentId && typeof frame.id === "string") entry.mainFrameId = frame.id;
        return;
      }
      case "Runtime.bindingCalled": {
        if (params.name !== ANNOTATOR_BINDING || typeof params.executionContextId !== "number") return;
        // Only our world's context of the top-level frame speaks for the page.
        if (params.executionContextId !== contextOf(entry, true)) return;
        const message = parsePageMessage(params.payload);
        if (message) void handlePage(entry, message);
        return;
      }
      default:
        return;
    }
  }

  async function handlePage(entry: Instrument, message: PageMessage): Promise<void> {
    const guestId = entry.contents.id;
    switch (message.type) {
      case "ready":
        await apply(entry);
        return;
      case "anchor":
        options.send({ kind: "annotator-anchor", guestId, rect: message.rect, viewport: message.viewport });
        return;
      case "pin-click":
        options.send({ kind: "annotator-pin-click", guestId, annotationId: message.id });
        return;
      case "pins":
        options.send({ kind: "annotator-pins", guestId, url: message.url, missing: message.missing });
        return;
      case "escape":
        options.send({ kind: "annotator-escape", guestId });
        return;
      case "outside-click":
        options.send({ kind: "annotator-outside-click", guestId });
        return;
      case "pick": {
        // The page hid its overlays for this frame; capture first, then let it show them again. A
        // dragged region is captured exactly; elements get a little padding.
        const padding = message.region ? 0 : SCREENSHOT_PADDING;
        const screenshot = await withTimeout(captureRect(entry, message.rect, message.viewport, padding), CAPTURE_TIMEOUT_MS, "capture").catch((error: unknown) => {
          options.log("浏览器批注：元素截图失败", String(error));
          return null;
        });
        void evaluateInWorld(entry, "globalThis.__cofluxAnnotatorApi && globalThis.__cofluxAnnotatorApi.show()").catch(() => undefined);
        const sources = await readSources(entry, message.token, message.elements.length);
        options.send({
          kind: "annotator-pick",
          guestId,
          pick: {
            token: message.token,
            url: message.url,
            title: message.title,
            rect: message.rect,
            viewport: message.viewport,
            targets: message.elements.map((element, index) => ({ element, source: sources[index] ?? null })),
            region: message.region,
            screenshot,
          },
        });
        return;
      }
    }
  }

  async function captureRect(entry: Instrument, rect: DesktopAnnotatorBox, viewport: DesktopAnnotatorViewport, padding: number): Promise<string | null> {
    // Only what is on screen can be captured: a union of distant elements is cut to the viewport.
    const visible = clipToViewport(rect, viewport);
    const fraction = visible ? elementCropFraction(visible, viewport, padding) : null;
    if (!fraction) return null;
    const image = await entry.contents.capturePage();
    if (image.isEmpty()) return null;
    const crop = cropRectInPixels(fraction, image.getSize());
    if (!crop) return null;
    let cropped: NativeImage = image.crop(crop);
    if (cropped.getSize().width > SCREENSHOT_MAX_WIDTH) cropped = cropped.resize({ width: SCREENSHOT_MAX_WIDTH, quality: "good" });
    const png = cropped.toPNG();
    if (png.byteLength <= SCREENSHOT_PNG_BUDGET) return `data:image/png;base64,${png.toString("base64")}`;
    return `data:image/jpeg;base64,${cropped.toJPEG(85).toString("base64")}`;
  }

  /** Every picked element's source identity within one shared budget; one that misses it is null. */
  async function readSources(entry: Instrument, token: string, count: number): Promise<(DesktopAnnotatorSource | null)[]> {
    const results: (DesktopAnnotatorSource | null)[] = Array.from({ length: count }, () => null);
    const reads = results.map((_, index) =>
      readSource(entry, token, index).then(
        (source) => {
          results[index] = source;
        },
        () => undefined,
      ),
    );
    await withTimeout(Promise.all(reads), SOURCE_BUDGET_MS, "source").catch(() => undefined);
    return [...results];
  }

  async function readSource(entry: Instrument, token: string, index: number): Promise<DesktopAnnotatorSource | null> {
    const mainContext = contextOf(entry, false);
    const worldContext = contextOf(entry, true);
    if (mainContext === null || worldContext === null) return null;
    const handle = record(
      await command(entry, "Runtime.evaluate", {
        expression: `globalThis.__cofluxAnnotatorApi && globalThis.__cofluxAnnotatorApi.pickedElement(${JSON.stringify(token)}, ${index})`,
        contextId: worldContext,
        silent: true,
      }),
    );
    const isolatedId = record(handle.result).objectId;
    if (typeof isolatedId !== "string") return null;
    const release = (objectId: string) => void command(entry, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    try {
      const described = record(await command(entry, "DOM.describeNode", { objectId: isolatedId }));
      const backendNodeId = record(described.node).backendNodeId;
      if (typeof backendNodeId !== "number") return null;
      const resolved = record(await command(entry, "DOM.resolveNode", { backendNodeId, executionContextId: mainContext }));
      const mainId = record(resolved.object).objectId;
      if (typeof mainId !== "string") return null;
      try {
        const called = record(
          await command(entry, "Runtime.callFunctionOn", { objectId: mainId, functionDeclaration: SOURCE_IDENTITY_READER, returnByValue: true, silent: true }),
        );
        return sanitizeSourceIdentity(record(called.result).value);
      } finally {
        release(mainId);
      }
    } finally {
      release(isolatedId);
    }
  }

  function forget(id: number): void {
    const entry = instruments.get(id);
    if (!entry) return;
    instruments.delete(id);
    entry.disposed = true;
    if (entry.reattachTimer !== null) clearTimeout(entry.reattachTimer);
    entry.reattachTimer = null;
    detach(entry);
  }

  function reset(): void {
    for (const id of [...instruments.keys()]) forget(id);
  }

  function retry(contents: WebContents): void {
    const entry = instruments.get(contents.id);
    if (!entry || entry.attached || !annotatorStateNeedsPage(entry.desired)) return;
    entry.reattachAttempts = 0;
    void ensure(entry);
  }

  return { adopt, sync, retry, forget, reset };
}
