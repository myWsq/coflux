import assert from "node:assert/strict";
import { test } from "node:test";

import { readScreenResolution, writeScreenResolution, type ScreenResolutionStore } from "./screen-resolution";

function memoryStore(initial: string | null): ScreenResolutionStore {
  let value = initial;
  return {
    key: "k",
    storage: {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
    },
  };
}

test("an absent, unparsable or unknown stored resolution reads as follow-the-window", () => {
  assert.equal(readScreenResolution(memoryStore(null), "d1"), null);
  assert.equal(readScreenResolution(memoryStore("{"), "d1"), null);
  assert.equal(readScreenResolution(memoryStore(JSON.stringify({ version: 2, devices: { d1: "1440x900" } })), "d1"), null);
  assert.equal(readScreenResolution(memoryStore(JSON.stringify({ version: 1, devices: { d1: "1441x900" } })), "d1"), null);
  assert.equal(readScreenResolution(memoryStore(JSON.stringify({ version: 1, devices: { d1: 1440 } })), "d1"), null);
  const throwing: ScreenResolutionStore = {
    key: "k",
    storage: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    },
  };
  assert.equal(readScreenResolution(throwing, "d1"), null);
  assert.equal(writeScreenResolution(throwing, "d1", { widthPoints: 1440, heightPoints: 900 }), false);
});

test("a chosen preset is remembered per device and follow-the-window forgets it", () => {
  const store = memoryStore(null);
  writeScreenResolution(store, "d1", { widthPoints: 1440, heightPoints: 900 });
  writeScreenResolution(store, "d2", { widthPoints: 1920, heightPoints: 1080 });
  assert.deepEqual(readScreenResolution(store, "d1"), { widthPoints: 1440, heightPoints: 900 });
  assert.deepEqual(readScreenResolution(store, "d2"), { widthPoints: 1920, heightPoints: 1080 });
  writeScreenResolution(store, "d1", null);
  assert.equal(readScreenResolution(store, "d1"), null);
  assert.deepEqual(readScreenResolution(store, "d2"), { widthPoints: 1920, heightPoints: 1080 });
});
