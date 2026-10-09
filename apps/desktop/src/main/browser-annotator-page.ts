import { ANNOTATOR_COLOURS } from "../shared/annotator-colours";
import { annotatorPinPosition } from "./browser-annotator-policy";

/**
 * The page half of browser annotations (plans 20260929-browser-annotations,
 * 20260929-annotation-polish): plain JavaScript the
 * main process injects over CDP into a named **isolated world** of a page guest
 * (`Page.addScriptToEvaluateOnNewDocument` with `worldName`, and into the current document when it
 * is first needed). Page scripts never see it: it shares the DOM, not the JavaScript globals. It
 * talks to main only through a `Runtime.addBinding` binding scoped to that world, and main calls
 * `__cofluxAnnotatorApi` in the same world.
 *
 * It does only what must happen inside the page — the gestures (hover, ↑/↓ level traversal, click,
 * shift-click selections finalised on shift release or blur, shift-drag regions on the live page),
 * hit-testing, locating elements again, rectangles, and the pins and outlines (drawn in a closed
 * shadow root, in the fixed `ANNOTATOR_COLOURS`, legible on any page) — and acts in the
 * top-level frame only. While a card is open (`capture`) it swallows pointer input and reports
 * clicks as outside clicks. The cards, attachments and panel are renderer UI.
 *
 * Written by hand for coflux (no third-party code). Kept free of template-literal syntax so it can
 * live in this raw string; the pin placement is `annotatorPinPosition`'s own source and the
 * colours are `ANNOTATOR_COLOURS` as JSON, both embedded.
 */

export const ANNOTATOR_WORLD = "coflux-annotator";
export const ANNOTATOR_BINDING = "__cofluxAnnotatorEmit";

export const ANNOTATOR_PAGE_SCRIPT =
  String.raw`(function () {
  "use strict";
  if (window.top !== window) return;
  if (globalThis.__cofluxAnnotatorApi) return;

  var BINDING = "__cofluxAnnotatorEmit";
  var ATTRIBUTES = ["role", "aria-label", "name", "type", "href", "alt", "placeholder", "title", "for", "data-testid", "data-test", "data-cy"];
  var STYLES = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
    "padding", "margin", "border", "border-radius", "box-shadow", "display", "gap", "width", "height", "opacity"];
  var TEST_ATTRIBUTES = ["data-testid", "data-test", "data-cy", "data-qa"];
  var DRAG_THRESHOLD = 5;
  var MAX_SELECTION = 24;
  var MAX_REGION_ELEMENTS = 12;
  var pinPosition = (` +
  annotatorPinPosition.toString() +
  String.raw`);
  var COLOURS = ` +
  JSON.stringify(ANNOTATOR_COLOURS) +
  String.raw`;

  var state = { mode: false, capture: false, pins: [], anchor: null, outlined: [] };
  var host = null, root = null, hoverBox = null, hoverLabel = null, anchorBox = null, dragBox = null, outlineLayer = null, pinLayer = null, cursorStyle = null;
  // token -> { elements: [...], region: null | { x, y, width, height } }; only the latest pick is kept.
  var picked = new Map();
  var nextToken = 1;
  var hidden = false;
  // annotation id -> its first element; its other elements only while it is outlined.
  var located = new Map();
  var extras = new Map();
  var pinNodes = new Map();
  var outlineNodes = [];
  var lastAnchor = "";
  var lastMissing = "";
  var frame = 0;
  var observer = null;
  var relocateTimer = 0;
  // An annotation to scroll into view once its element is found (it may render after the page loads).
  var pendingScroll = null;
  // Hover and level traversal: the element under the pointer, the one ↑/↓ chose, the path ↑ climbed.
  var hoverBase = null, hoverEl = null, levels = [];
  // A shift-click selection being built, and a shift-press that may become a drag.
  var selection = [];
  var press = null;
  var suppressClick = false;

  function emit(message) {
    try {
      var send = globalThis[BINDING];
      if (typeof send === "function") send(JSON.stringify(message));
    } catch (error) {}
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function rectOf(element) {
    var box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }

  function union(rects) {
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (var i = 0; i < rects.length; i++) {
      left = Math.min(left, rects[i].x);
      top = Math.min(top, rects[i].y);
      right = Math.max(right, rects[i].x + rects[i].width);
      bottom = Math.max(bottom, rects[i].y + rects[i].height);
    }
    return rects.length ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  function regionRect(element, region) {
    var base = rectOf(element);
    return { x: base.x + region.x, y: base.y + region.y, width: region.width, height: region.height };
  }

  function contains(outer, inner) {
    return outer.x <= inner.x + 1 && outer.y <= inner.y + 1 && outer.x + outer.width >= inner.x + inner.width - 1 && outer.y + outer.height >= inner.y + inner.height - 1;
  }

  function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  function connected(element) {
    return !!element && element.isConnected;
  }

  function clip(value, max) {
    value = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max) : value;
  }

  function escapeCss(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function count(selector) {
    try { return document.querySelectorAll(selector).length; } catch (error) { return 0; }
  }

  function stableClass(name) {
    return name.length > 0 && name.length <= 40 && !/\d{3,}/.test(name) && !/^(css|sc|jsx|emotion|svelte)-/.test(name) && !/__[A-Za-z0-9]{5}$/.test(name);
  }

  function stableId(id) {
    return id && id.length <= 64 && !/\d{4,}/.test(id) && !/^[:0-9]/.test(id);
  }

  function nthOfType(element) {
    var index = 1, total = 0, sibling;
    var parent = element.parentElement;
    if (!parent) return "";
    for (sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.tagName !== element.tagName) continue;
      total += 1;
      if (sibling === element) index = total;
    }
    return total > 1 ? ":nth-of-type(" + index + ")" : "";
  }

  function domPath(element) {
    var parts = [];
    for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + nthOfType(node));
      if (node === document.documentElement) break;
    }
    return parts.join(" > ");
  }

  function uniqueSelector(element) {
    var tag = element.tagName.toLowerCase();
    if (stableId(element.id)) {
      var byId = "#" + escapeCss(element.id);
      if (count(byId) === 1) return byId;
    }
    for (var i = 0; i < TEST_ATTRIBUTES.length; i++) {
      var value = element.getAttribute(TEST_ATTRIBUTES[i]);
      if (!value) continue;
      var byTest = tag + "[" + TEST_ATTRIBUTES[i] + "=\"" + value.replace(/["\\]/g, "\\$&") + "\"]";
      if (count(byTest) === 1) return byTest;
    }
    var parts = [];
    var node = element;
    for (var depth = 0; node && node.nodeType === 1 && depth < 12; depth++, node = node.parentElement) {
      if (node !== element && stableId(node.id)) {
        var anchored = "#" + escapeCss(node.id) + " > " + parts.join(" > ");
        if (count(anchored) === 1) return anchored;
      }
      var step = node.tagName.toLowerCase();
      var classes = Array.prototype.filter.call(node.classList, stableClass).slice(0, 2);
      if (classes.length) step += "." + classes.map(escapeCss).join(".");
      step += nthOfType(node);
      parts.unshift(step);
      var candidate = parts.join(" > ");
      if (count(candidate) === 1) return candidate;
      if (node === document.body) break;
    }
    return domPath(element);
  }

  function describe(element) {
    var attributes = {};
    for (var i = 0; i < ATTRIBUTES.length; i++) {
      var value = element.getAttribute(ATTRIBUTES[i]);
      if (value) attributes[ATTRIBUTES[i]] = clip(value, 300);
    }
    var styles = {};
    var computed = window.getComputedStyle(element);
    for (var j = 0; j < STYLES.length; j++) {
      var style = computed.getPropertyValue(STYLES[j]);
      if (style) styles[STYLES[j]] = clip(style, 200);
    }
    var box = element.getBoundingClientRect();
    return {
      selector: uniqueSelector(element),
      domPath: domPath(element),
      tag: element.tagName.toLowerCase(),
      text: clip(element.innerText || element.textContent || "", 300),
      elementId: element.id || "",
      classes: Array.prototype.slice.call(element.classList, 0, 16),
      attributes: attributes,
      styles: styles,
      width: Math.round(box.width),
      height: Math.round(box.height)
    };
  }

  // Finding an annotated element again: every candidate the stored selector, DOM path, id or text
  // can produce is scored; the best one above the threshold wins.
  function score(locator, element, selectorMatches, pathMatches) {
    var total = 0;
    if (selectorMatches) total += selectorMatches === 1 ? 5 : 2;
    if (pathMatches) total += 3;
    if (locator.elementId && element.id === locator.elementId) total += 4;
    if (locator.tag && element.tagName.toLowerCase() === locator.tag) total += 1;
    if (locator.text) {
      var current = clip(element.innerText || element.textContent || "", 300);
      if (current === locator.text) total += 3;
      else if (current && locator.text.indexOf(current.slice(0, 40)) === 0) total += 1;
    }
    if (locator.classes && locator.classes.length) {
      var shared = 0;
      for (var i = 0; i < locator.classes.length; i++) if (element.classList.contains(locator.classes[i])) shared++;
      total += 2 * shared / locator.classes.length;
    }
    return total;
  }

  function locate(locator) {
    if (!locator) return null;
    var candidates = [];
    var bySelector = [], byPath = [];
    function add(list, into) {
      for (var i = 0; i < list.length && i < 50; i++) {
        if (into) into.push(list[i]);
        if (candidates.indexOf(list[i]) < 0) candidates.push(list[i]);
      }
    }
    try { if (locator.selector) add(document.querySelectorAll(locator.selector), bySelector); } catch (error) {}
    try { if (locator.domPath) add(document.querySelectorAll(locator.domPath), byPath); } catch (error) {}
    if (locator.elementId) {
      var byId = document.getElementById(locator.elementId);
      if (byId) add([byId]);
    }
    var best = null, bestScore = 0;
    function consider(element) {
      if (host && (element === host || host.contains(element))) return;
      var value = score(locator, element, bySelector.indexOf(element) >= 0 ? bySelector.length : 0, byPath.indexOf(element) >= 0);
      if (value > bestScore) { best = element; bestScore = value; }
    }
    candidates.forEach(consider);
    if (bestScore < 4 && locator.tag && locator.text) {
      var same = document.getElementsByTagName(locator.tag);
      for (var i = 0; i < same.length && i < 3000; i++) consider(same[i]);
    }
    return bestScore >= 4 ? best : null;
  }

  function ensureUi() {
    if (host && host.isConnected) return true;
    var parent = document.documentElement;
    if (!parent) return false;
    if (!host) {
      host = document.createElement("coflux-annotator");
      host.setAttribute("style", "all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; display: block !important;");
      root = host.attachShadow({ mode: "closed" });
      var style = document.createElement("style");
      // Fixed colours, not the app theme: they must stay visible on any page. Every box carries a
      // 1 px ring (--cr) outside its coloured border; the anchor's halo lies beyond that ring.
      style.textContent = [
        ":host{--ca:" + COLOURS.accent + ";--con:" + COLOURS.onAccent + ";--cs:" + COLOURS.success + ";--cson:" + COLOURS.onSuccess + ";--cr:" + COLOURS.ring + "}",
        ".hover,.anchor,.outline,.drag{position:fixed;display:none;box-sizing:border-box;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px var(--cr)}",
        ".hover{border:1.5px solid var(--ca);background:color-mix(in srgb,var(--ca) 10%,transparent)}",
        ".anchor{border:2px solid var(--ca);box-shadow:0 0 0 1px var(--cr),0 0 0 4px color-mix(in srgb,var(--ca) 22%,transparent)}",
        ".outline{border:1.5px dashed var(--ca)}",
        ".outline.sel{border-style:solid;background:color-mix(in srgb,var(--ca) 14%,transparent)}",
        ".drag{border:1.5px dashed var(--ca);background:color-mix(in srgb,var(--ca) 10%,transparent)}",
        ".label{position:fixed;display:none;font:500 12px/18px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--con);background:var(--ca);padding:0 6px;border-radius:4px;pointer-events:none;white-space:nowrap}",
        ".pin{position:fixed;display:flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;",
        "font:600 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--con);background:var(--ca);border:1.5px solid var(--con);box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto}",
        ".pin.resolved{color:var(--cson);background:var(--cs);border-color:var(--cson)}",
        ".pin:hover{filter:brightness(1.08)}"
      ].join("");
      root.appendChild(style);
      outlineLayer = document.createElement("div"); root.appendChild(outlineLayer);
      hoverBox = document.createElement("div"); hoverBox.className = "hover"; root.appendChild(hoverBox);
      anchorBox = document.createElement("div"); anchorBox.className = "anchor"; root.appendChild(anchorBox);
      dragBox = document.createElement("div"); dragBox.className = "drag"; root.appendChild(dragBox);
      pinLayer = document.createElement("div"); root.appendChild(pinLayer);
      hoverLabel = document.createElement("div"); hoverLabel.className = "label"; root.appendChild(hoverLabel);
    }
    parent.appendChild(host);
    return true;
  }

  function place(node, rect) {
    node.style.left = rect.x + "px";
    node.style.top = rect.y + "px";
    node.style.width = rect.width + "px";
    node.style.height = rect.height + "px";
    node.style.display = "block";
  }

  function isOurs(element) {
    return !element || element === host || element === document.documentElement || (host && host.contains(element));
  }

  function inHost(event) {
    var path = event.composedPath ? event.composedPath() : [];
    return !!host && path.indexOf(host) >= 0;
  }

  function targetAt(x, y) {
    var element = document.elementFromPoint(x, y);
    return isOurs(element) ? null : element;
  }

  function active() {
    return state.mode || state.capture;
  }

  function picking() {
    return state.mode && !state.capture && !hidden;
  }

  // ---- hover and level traversal ----

  function labelFor(element) {
    var name = element.tagName.toLowerCase();
    var classes = Array.prototype.filter.call(element.classList, stableClass);
    if (classes.length) name += "." + classes[0];
    var box = element.getBoundingClientRect();
    return name + " \u00b7 " + Math.round(box.width) + "\u00d7" + Math.round(box.height);
  }

  function hideHover() {
    if (hoverBox) hoverBox.style.display = "none";
    if (hoverLabel) hoverLabel.style.display = "none";
  }

  function showHover() {
    if (!picking() || press && press.dragging || !connected(hoverEl) || !ensureUi()) { hideHover(); return; }
    var rect = rectOf(hoverEl);
    place(hoverBox, rect);
    hoverLabel.textContent = labelFor(hoverEl);
    hoverLabel.style.left = Math.max(0, Math.min(rect.x, window.innerWidth - 40)) + "px";
    hoverLabel.style.top = (rect.y >= 22 ? rect.y - 22 : Math.min(window.innerHeight - 20, rect.y + rect.height + 4)) + "px";
    hoverLabel.style.display = "block";
  }

  function resetHover() {
    hoverBase = null; hoverEl = null; levels = [];
    hideHover();
  }

  // ---- gestures ----

  function onPointerMove(event) {
    if (!picking()) return;
    if (press) {
      if (!press.dragging && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > DRAG_THRESHOLD) press.dragging = true;
      if (press.dragging) {
        hideHover();
        if (ensureUi()) place(dragBox, boxBetween(press.x, press.y, event.clientX, event.clientY));
        return;
      }
    }
    var target = targetAt(event.clientX, event.clientY);
    // A new element under the pointer resets the level ↑ climbed; moving within it keeps it.
    if (target !== hoverBase) { hoverBase = target; hoverEl = target; levels = []; }
    showHover();
  }

  function boxBetween(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }

  function hideDrag() {
    if (dragBox) dragBox.style.display = "none";
  }

  function swallow(event) {
    if (!active() || inHost(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerDown(event) {
    if (!active() || inHost(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
    press = picking() && event.button === 0 && event.shiftKey ? { x: event.clientX, y: event.clientY, dragging: false } : null;
  }

  function onPointerUp(event) {
    if (!active() || inHost(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var current = press;
    press = null;
    if (current && current.dragging) {
      hideDrag();
      // The click that follows a drag is part of it.
      suppressClick = true;
      pickRegion(boxBetween(current.x, current.y, event.clientX, event.clientY));
    }
  }

  function onClick(event) {
    if (!active() || inHost(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (suppressClick) { suppressClick = false; return; }
    if (state.capture) { emit({ type: "outside-click" }); return; }
    if (!picking()) return;
    var under = targetAt(event.clientX, event.clientY);
    var target = under && under === hoverBase && connected(hoverEl) ? hoverEl : under;
    if (!target) return;
    if (event.shiftKey) { toggleSelection(target); return; }
    selection = [];
    pickElements([target], null);
  }

  function toggleSelection(element) {
    var index = selection.indexOf(element);
    if (index >= 0) selection.splice(index, 1);
    else if (selection.length < MAX_SELECTION) selection.push(element);
    schedule();
  }

  // A shift-click selection becomes one pick when shift is released — or when focus leaves, so a
  // missed keyup cannot leave it pending.
  function finishSelection() {
    if (!selection.length) return;
    var elements = selection.filter(connected);
    selection = [];
    if (elements.length && picking()) pickElements(elements, null);
    else schedule();
  }

  function onKeyDown(event) {
    if (!active()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!state.capture && (selection.length || press)) {
        selection = []; press = null; hideDrag(); schedule();
        return;
      }
      emit({ type: "escape" });
      return;
    }
    // ↑ selects the parent of the hovered element, ↓ goes back down the path ↑ climbed. Only while
    // there is a hover target: otherwise the arrows scroll the page as usual.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && picking() && connected(hoverEl) && !event.metaKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "ArrowUp") {
        var parent = hoverEl.parentElement;
        if (parent && !isOurs(parent)) { levels.push(hoverEl); hoverEl = parent; }
      } else if (levels.length) {
        hoverEl = levels.pop();
      }
      showHover();
    }
  }

  function onKeyUp(event) {
    if (event.key === "Shift") finishSelection();
  }

  function onBlur() {
    press = null;
    hideDrag();
    finishSelection();
  }

  // ---- picks ----

  function pickRect(entry) {
    if (!connected(entry.elements[0])) return null;
    if (entry.region) return regionRect(entry.elements[0], entry.region);
    return union(entry.elements.filter(connected).map(rectOf));
  }

  // The region is anchored to the innermost element that fully contains it (so it follows scrolling
  // and reflow); <body> as a last resort, which makes it a fixed document position.
  function containerOf(box) {
    var element = targetAt(box.x + box.width / 2, box.y + box.height / 2);
    for (; element && element !== document.documentElement; element = element.parentElement) {
      if (element === document.body || contains(rectOf(element), box)) return element;
    }
    return document.body;
  }

  // The outermost elements lying fully inside the region.
  function elementsInside(container, box) {
    var found = [];
    var queue = Array.prototype.slice.call(container.children);
    for (var visited = 0; queue.length && found.length < MAX_REGION_ELEMENTS && visited < 3000; visited++) {
      var element = queue.shift();
      if (isOurs(element)) continue;
      var rect = rectOf(element);
      if (rect.width < 1 && rect.height < 1) { Array.prototype.push.apply(queue, element.children); continue; }
      if (contains(box, rect)) { found.push(element); continue; }
      if (intersects(box, rect)) Array.prototype.push.apply(queue, element.children);
    }
    return found;
  }

  function pickRegion(box) {
    if (box.width < 4 || box.height < 4) return;
    var container = containerOf(box);
    if (!container) return;
    var base = rectOf(container);
    var region = { x: box.x - base.x, y: box.y - base.y, width: box.width, height: box.height };
    pickElements([container].concat(elementsInside(container, box)), region);
  }

  function pickElements(elements, region) {
    var token = "p" + nextToken++;
    picked.clear();
    picked.set(token, { elements: elements, region: region });
    state.anchor = { kind: "pick", token: token };
    resetHover();
    // Hide the overlays for the frame the screenshot is taken from; main shows them again.
    setHidden(true);
    // Main shows them again once it has the screenshot; never leave them hidden if it does not.
    setTimeout(function () { if (hidden) { setHidden(false); schedule(); } }, 4000);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var entry = picked.get(token);
        var rect = entry ? pickRect(entry) : null;
        if (!rect) { setHidden(false); schedule(); return; }
        emit({
          type: "pick", token: token, url: location.href, title: document.title, rect: rect, viewport: viewport(),
          elements: entry.elements.map(describe), region: region
        });
      });
    });
  }

  function setHidden(value) {
    hidden = value;
    if (host) host.style.setProperty("visibility", value ? "hidden" : "visible", "important");
    if (value) { hideHover(); hideDrag(); }
  }

  // ---- annotations on the page ----

  function pinById(id) {
    for (var i = 0; i < state.pins.length; i++) if (state.pins[i].id === id) return state.pins[i];
    return null;
  }

  function pinRect(pin) {
    var element = located.get(pin.id);
    if (!connected(element)) return null;
    return pin.region ? regionRect(element, pin.region) : rectOf(element);
  }

  function anchorRect() {
    var anchor = state.anchor;
    if (!anchor) return null;
    if (anchor.kind === "pick") {
      var entry = picked.get(anchor.token);
      return entry ? pickRect(entry) : null;
    }
    var pin = pinById(anchor.id);
    return pin ? pinRect(pin) : null;
  }

  function relocate() {
    var missing = [];
    var alive = new Set();
    for (var i = 0; i < state.pins.length; i++) {
      var pin = state.pins[i];
      alive.add(pin.id);
      // Relocation keys off the first element only; a region follows it.
      var current = located.get(pin.id);
      if (!connected(current)) {
        current = locate(pin.targets[0]);
        if (current) located.set(pin.id, current); else located.delete(pin.id);
      }
      if (!current) missing.push(pin.id);
    }
    // The other elements, only for the annotations being outlined.
    var wanted = new Set();
    for (var j = 0; j < state.outlined.length; j++) {
      var outlined = pinById(state.outlined[j]);
      if (!outlined || outlined.region || outlined.targets.length < 2) continue;
      wanted.add(outlined.id);
      var others = extras.get(outlined.id) || [];
      for (var k = 1; k < outlined.targets.length; k++) {
        if (!connected(others[k - 1])) others[k - 1] = locate(outlined.targets[k]);
      }
      extras.set(outlined.id, others);
    }
    extras.forEach(function (_, id) { if (!wanted.has(id)) extras.delete(id); });
    if (pendingScroll) {
      var target = located.get(pendingScroll);
      if (target) {
        pendingScroll = null;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    located.forEach(function (_, id) { if (!alive.has(id)) located.delete(id); });
    var key = location.href + "|" + missing.join(",");
    if (key !== lastMissing) {
      lastMissing = key;
      emit({ type: "pins", url: location.href, missing: missing });
    }
  }

  function renderPins() {
    if (!pinLayer) return;
    var view = viewport();
    var wanted = new Set();
    for (var i = 0; i < state.pins.length; i++) {
      var pin = state.pins[i];
      var rect = pinRect(pin);
      var node = pinNodes.get(pin.id);
      if (!rect) { if (node) node.style.display = "none"; continue; }
      wanted.add(pin.id);
      if (!node) {
        node = document.createElement("div");
        (function (id) {
          node.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); emit({ type: "pin-click", id: id }); });
          node.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
          node.addEventListener("mousedown", function (event) { event.stopPropagation(); });
        })(pin.id);
        pinNodes.set(pin.id, node);
        pinLayer.appendChild(node);
      }
      node.className = pin.resolved ? "pin resolved" : "pin";
      node.textContent = pin.resolved ? "\u2713" : String(pin.number);
      var visible = rect.width + rect.height > 0 && rect.y + rect.height >= 0 && rect.y <= view.height && rect.x + rect.width >= 0 && rect.x <= view.width;
      node.style.display = visible ? "flex" : "none";
      if (!visible) continue;
      var position = pinPosition(rect, view, node.offsetWidth || 18, node.offsetHeight || 18, !!pin.region);
      node.style.left = position.x + "px";
      node.style.top = position.y + "px";
    }
    pinNodes.forEach(function (node, id) {
      if (!pinById(id)) { node.remove(); pinNodes.delete(id); }
      else if (!wanted.has(id)) node.style.display = "none";
    });
  }

  function renderOutlines() {
    if (!outlineLayer) return;
    var boxes = [];
    function add(rect, kind) { if (rect && rect.width + rect.height > 0) boxes.push({ rect: rect, kind: kind }); }
    // The shift-click selection being built.
    for (var i = 0; i < selection.length; i++) if (connected(selection[i])) add(rectOf(selection[i]), "sel");
    // The pick a card is open for: its other elements, or its region.
    var anchor = state.anchor;
    if (anchor && anchor.kind === "pick") {
      var entry = picked.get(anchor.token);
      if (entry && connected(entry.elements[0])) {
        if (entry.region) add(regionRect(entry.elements[0], entry.region), "dashed");
        else for (var j = 1; j < entry.elements.length; j++) if (connected(entry.elements[j])) add(rectOf(entry.elements[j]), "dashed");
      }
    }
    // Outlined annotations: every element, or the region.
    for (var k = 0; k < state.outlined.length; k++) {
      var pin = pinById(state.outlined[k]);
      var first = pin ? located.get(pin.id) : null;
      if (!connected(first)) continue;
      if (pin.region) { add(regionRect(first, pin.region), "dashed"); continue; }
      add(rectOf(first), "dashed");
      var others = extras.get(pin.id) || [];
      for (var m = 0; m < others.length; m++) if (connected(others[m])) add(rectOf(others[m]), "dashed");
    }
    while (outlineNodes.length < boxes.length) {
      var node = document.createElement("div");
      outlineLayer.appendChild(node);
      outlineNodes.push(node);
    }
    for (var n = 0; n < outlineNodes.length; n++) {
      if (n >= boxes.length) { outlineNodes[n].style.display = "none"; continue; }
      outlineNodes[n].className = boxes[n].kind === "sel" ? "outline sel" : "outline";
      place(outlineNodes[n], boxes[n].rect);
    }
  }

  function renderAnchor() {
    var rect = anchorRect();
    if (anchorBox) {
      // The solid box marks a new pick's first element; regions and stored annotations are dashed.
      var anchor = state.anchor;
      var entry = anchor && anchor.kind === "pick" ? picked.get(anchor.token) : null;
      if (entry && !entry.region && connected(entry.elements[0]) && !hidden) place(anchorBox, rectOf(entry.elements[0]));
      else anchorBox.style.display = "none";
    }
    var view = viewport();
    var key = rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height), view.width, view.height].join(",") : "none," + view.width + "," + view.height;
    if (key !== lastAnchor && state.anchor) {
      lastAnchor = key;
      emit({ type: "anchor", rect: rect, viewport: view });
    }
    if (!state.anchor) lastAnchor = "";
  }

  function render() {
    frame = 0;
    if (!needed()) { if (host && host.isConnected) host.remove(); return; }
    if (!ensureUi()) return;
    renderPins();
    renderOutlines();
    renderAnchor();
    showHover();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(render);
  }

  function scheduleRelocate() {
    if (relocateTimer) return;
    relocateTimer = setTimeout(function () {
      relocateTimer = 0;
      if (!state.pins.length) return;
      relocate();
      schedule();
    }, 400);
  }

  function needed() {
    return state.mode || state.capture || state.pins.length > 0 || state.anchor !== null || selection.length > 0;
  }

  function watchDom() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (host && (target === host || host.contains(target))) continue;
        scheduleRelocate();
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  var api = {
    apply: function (next) {
      var previous = state.anchor;
      state = {
        mode: !!next.mode,
        capture: !!next.capture,
        pins: Array.isArray(next.pins) ? next.pins : [],
        anchor: next.anchor || null,
        outlined: Array.isArray(next.outlined) ? next.outlined : []
      };
      // Only the latest pick is kept, and it is not dropped by a state sent before the renderer
      // heard of it (main still reads its elements' source identity).
      if (state.anchor && state.anchor.kind === "pick" && !picked.has(state.anchor.token)) state.anchor = null;
      if (!state.mode || state.capture) { selection = []; press = null; hideDrag(); resetHover(); }
      if (cursorStyle) cursorStyle.disabled = !state.mode || state.capture;
      else if (state.mode && !state.capture && document.head) {
        cursorStyle = document.createElement("style");
        cursorStyle.textContent = "html, html * { cursor: crosshair !important; }";
        document.head.appendChild(cursorStyle);
      }
      var anchor = state.anchor;
      if (anchor && anchor.kind === "pin" && anchor.scroll && (!previous || previous.kind !== "pin" || previous.id !== anchor.id)) {
        pendingScroll = anchor.id;
      } else if (!anchor || anchor.kind !== "pin") {
        pendingScroll = null;
      }
      if (state.pins.length) { watchDom(); relocate(); }
      else if (lastMissing) { lastMissing = ""; }
      lastAnchor = "";
      schedule();
      return true;
    },
    show: function () {
      setHidden(false);
      schedule();
      return true;
    },
    pickedElement: function (token, index) {
      var entry = picked.get(token);
      return entry ? entry.elements[index] || null : null;
    }
  };
  Object.defineProperty(globalThis, "__cofluxAnnotatorApi", { value: api, configurable: false, enumerable: false, writable: false });

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("mousedown", swallow, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("mouseup", swallow, true);
  window.addEventListener("dblclick", swallow, true);
  window.addEventListener("contextmenu", swallow, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  setInterval(function () { if (needed()) schedule(); }, 500);

  function announce() { emit({ type: "ready", url: location.href }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
  else announce();
})();`;

/**
 * Runs in the page's **main** world with `this` = one picked element (`Runtime.callFunctionOn`):
 * reads framework source identity from the page's own development data. React: the fiber on the
 * element, component names up the `return` chain and `_debugSource` (React ≤ 18 development builds;
 * React 19 has names only). Vue 3: `__vueParentComponent` and `type.__file`; Vue 2: `__vue__`.
 * Pure reads with bounded loops; any failure yields what was found so far. Returned by value.
 */
export const SOURCE_IDENTITY_READER = String.raw`function () {
  var out = { framework: "", components: [], file: "", line: 0, column: 0 };
  function push(name) {
    if (typeof name !== "string" || !name || name.length > 200) return;
    if (out.components[out.components.length - 1] !== name) out.components.push(name);
  }
  function reactName(type, depth) {
    if (!type || depth > 4) return "";
    if (typeof type === "function") return type.displayName || type.name || "";
    if (typeof type === "object") {
      if (typeof type.displayName === "string") return type.displayName;
      if (type.render) return reactName(type.render, depth + 1);
      if (type.type) return reactName(type.type, depth + 1);
    }
    return "";
  }
  try {
    var element = this;
    for (var up = 0; element && up < 8 && !out.framework; up++, element = element.parentElement) {
      var keys = Object.keys(element);
      var fiber = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fiber = element[keys[i]]; break; }
      }
      if (fiber) {
        out.framework = "react";
        for (var node = fiber, steps = 0; node && steps < 300 && out.components.length < 12; node = node.return, steps++) {
          if (typeof node.type !== "string") push(reactName(node.type, 0));
          var source = node._debugSource;
          if (!out.file && source && typeof source.fileName === "string") {
            out.file = source.fileName;
            out.line = Number(source.lineNumber) || 0;
            out.column = Number(source.columnNumber) || 0;
          }
        }
        break;
      }
      var instance = element.__vueParentComponent;
      if (instance) {
        out.framework = "vue";
        for (var steps3 = 0; instance && steps3 < 50 && out.components.length < 12; instance = instance.parent, steps3++) {
          var type = instance.type || {};
          var file = typeof type.__file === "string" ? type.__file : "";
          push(type.name || type.__name || (file ? file.split("/").pop().replace(/\.vue$/, "") : ""));
          if (!out.file && file) out.file = file;
        }
        break;
      }
      var vm = element.__vue__;
      if (vm) {
        out.framework = "vue";
        for (var steps2 = 0; vm && steps2 < 50 && out.components.length < 12; vm = vm.$parent, steps2++) {
          var options = vm.$options || {};
          push(options.name || options._componentTag || "");
          if (!out.file && typeof options.__file === "string") out.file = options.__file;
        }
        break;
      }
    }
  } catch (error) {}
  return out;
}`;
