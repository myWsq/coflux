import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldCopyTerminalFileReference, shouldOpenTerminalWebLink } from "./terminal-link-activation";

test("a web link opens on a plain primary click, with or without modifiers", () => {
  assert.equal(shouldOpenTerminalWebLink({ button: 0 }, false), true);
  assert.equal(shouldOpenTerminalWebLink({}, false), true);
  assert.equal(shouldOpenTerminalWebLink({ button: 0, metaKey: true }, false), true);
});

test("a web link does not open from a right or middle click, nor at the end of a drag-selection", () => {
  assert.equal(shouldOpenTerminalWebLink({ button: 2 }, false), false);
  assert.equal(shouldOpenTerminalWebLink({ button: 1 }, false), false);
  assert.equal(shouldOpenTerminalWebLink({ button: 0 }, true), false);
});

test("a file reference still needs ⌘ (or Ctrl) and the primary button", () => {
  assert.equal(shouldCopyTerminalFileReference({ button: 0 }), false);
  assert.equal(shouldCopyTerminalFileReference({ button: 0, metaKey: true }), true);
  assert.equal(shouldCopyTerminalFileReference({ button: 0, ctrlKey: true }), true);
  assert.equal(shouldCopyTerminalFileReference({ button: 2, metaKey: true }), false);
});
