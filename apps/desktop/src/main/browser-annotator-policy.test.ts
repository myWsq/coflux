import assert from "node:assert/strict";
import { test } from "node:test";

import {
  annotatorPinPosition,
  annotatorStateNeedsPage,
  clipToViewport,
  elementCropFraction,
  parsePageMessage,
  sanitizeAnnotatorSync,
  sanitizeSourceIdentity,
} from "./browser-annotator-policy";
import { ANNOTATOR_PAGE_SCRIPT } from "./browser-annotator-page";

test("annotator sync: ids and pins are validated, unknown anchors dropped", () => {
  const parsed = sanitizeAnnotatorSync({
    guestId: 7,
    state: {
      mode: true,
      pins: [
        {
          id: "ann-1",
          number: 2,
          resolved: true,
          targets: [
            { selector: "#a", domPath: "html > body", tag: "BUTTON", text: "Save", elementId: "a", classes: ["x", 3] },
            { selector: "nav", tag: "nav" },
          ],
          region: { x: -3, y: 4, width: 0, height: 10 },
        },
        { id: "ann-3", number: 3, targets: [{ tag: "div" }], region: { x: 1, y: 2, width: 30, height: 40 } },
        { id: "../bad", number: 1, targets: [{ tag: "a" }] },
        { id: "ann-2", number: 4, targets: [] },
      ],
      anchor: { kind: "pin", id: "ann-1", scroll: true },
      outlined: ["ann-1", "no good"],
      capture: true,
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.guestId, 7);
  assert.deepEqual(parsed.state.pins.map((pin) => pin.id), ["ann-1", "ann-3"]);
  assert.equal(parsed.state.pins[0]!.targets[0]!.tag, "button");
  assert.deepEqual(parsed.state.pins[0]!.targets[0]!.classes, ["x"]);
  assert.equal(parsed.state.pins[0]!.targets.length, 2);
  assert.equal(parsed.state.pins[0]!.region, null);
  assert.deepEqual(parsed.state.pins[1]!.region, { x: 1, y: 2, width: 30, height: 40 });
  assert.deepEqual(parsed.state.anchor, { kind: "pin", id: "ann-1", scroll: true });
  assert.deepEqual(parsed.state.outlined, ["ann-1"]);
  assert.equal(parsed.state.capture, true);
  assert.equal(sanitizeAnnotatorSync({ guestId: -1, state: {} }), null);
  assert.equal(sanitizeAnnotatorSync({ guestId: 1, state: { anchor: { kind: "pick", token: "a b" } } })?.state.anchor, null);
  // Outlines and capture alone never attach a debugger.
  const quiet = { mode: false, capture: true, pins: [], anchor: null, outlined: ["ann-1"] };
  assert.equal(annotatorStateNeedsPage(quiet), false);
  assert.equal(annotatorStateNeedsPage({ ...quiet, mode: true }), true);
});

test("page messages: only known shapes pass", () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: "escape" })), { type: "escape" });
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: "outside-click" })), { type: "outside-click" });
  assert.equal(parsePageMessage("{"), null);
  assert.equal(parsePageMessage(JSON.stringify({ type: "eval", code: "x" })), null);
  const pick = parsePageMessage(
    JSON.stringify({
      type: "pick",
      token: "p1",
      url: "http://localhost:3000/",
      title: "Home",
      rect: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 800, height: 600 },
      elements: [
        { tag: "DIV", selector: "div", attributes: { role: "button" }, styles: { color: "red" }, width: 30, height: 40 },
        { tag: "SPAN", selector: "span" },
      ],
      region: { x: 2, y: 3, width: 20, height: 10 },
    }),
  );
  assert.equal(pick?.type, "pick");
  assert.equal(pick?.type === "pick" ? pick.elements.length : 0, 2);
  assert.deepEqual(pick?.type === "pick" ? pick.region : null, { x: 2, y: 3, width: 20, height: 10 });
  // A pick with no element, or with one unreadable element, is not a pick.
  const base = { type: "pick", token: "p2", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 10, height: 10 } };
  assert.equal(parsePageMessage(JSON.stringify({ ...base, elements: [] })), null);
  assert.equal(parsePageMessage(JSON.stringify({ ...base, elements: [{ tag: "a" }, "x"] })), null);
  assert.equal(parsePageMessage(JSON.stringify({ type: "pin-click", id: "x/y" })), null);
});

test("source identity: empty is null, location only with a file", () => {
  assert.equal(sanitizeSourceIdentity({ framework: "", components: [], file: "" }), null);
  assert.deepEqual(sanitizeSourceIdentity({ framework: "React", components: ["Button", "Toolbar"], file: "", line: 3 }), {
    framework: "react",
    components: ["Button", "Toolbar"],
    file: "",
    line: 0,
    column: 0,
  });
});

test("element crop: padded, clipped to the viewport, null when off screen", () => {
  const crop = elementCropFraction({ x: 0, y: 100, width: 200, height: 100 }, { width: 1000, height: 500 }, 10);
  assert.deepEqual(crop, { x: 0, y: 90 / 500, width: 210 / 1000, height: 120 / 500 });
  assert.equal(elementCropFraction({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1000, height: 500 }), null);
});

test("screenshot rect: clipped to the viewport", () => {
  assert.deepEqual(clipToViewport({ x: -10, y: 480, width: 50, height: 100 }, { width: 1000, height: 500 }), { x: 0, y: 480, width: 40, height: 20 });
  assert.equal(clipToViewport({ x: 0, y: 600, width: 50, height: 100 }, { width: 1000, height: 500 }), null);
});

test("pins sit outside an element's top-right corner, on a region's top-left corner, inside the viewport", () => {
  const viewport = { width: 1000, height: 600 };
  // Right of the top-right corner, centred on the top edge: never over the element.
  assert.deepEqual(annotatorPinPosition({ x: 100, y: 200, width: 80, height: 30 }, viewport, 18, 18, false), { x: 184, y: 191 });
  // No room on the right: above the corner.
  assert.deepEqual(annotatorPinPosition({ x: 0, y: 200, width: 1000, height: 30 }, viewport, 18, 18, false), { x: 978, y: 178 });
  // At the top of the viewport it stays inside.
  assert.deepEqual(annotatorPinPosition({ x: 0, y: 0, width: 1000, height: 30 }, viewport, 18, 18, false), { x: 978, y: 4 });
  // A region: centred on its top-left corner.
  assert.deepEqual(annotatorPinPosition({ x: 300, y: 100, width: 200, height: 50 }, viewport, 20, 18, true), { x: 290, y: 91 });
});

test("the page script embeds the pin placement and has no type below 11 px", () => {
  assert.ok(ANNOTATOR_PAGE_SCRIPT.includes("var pinPosition = (function"));
  assert.doesNotMatch(ANNOTATOR_PAGE_SCRIPT, /font:[^;"]*\b(?:[0-9]|10)px/);
});
