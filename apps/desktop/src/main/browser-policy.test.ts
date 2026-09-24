import assert from "node:assert/strict";
import { test } from "node:test";

import { BROWSER_DEVTOOLS_PARTITION, BROWSER_PARTITION_PREFIX } from "../shared/browser-partitions";
import {
  browserPartitionFor,
  classifyGuestKey,
  cropRectInPixels,
  decideWebviewAttach,
  isAllowedDevToolsNavigation,
  isAllowedPageNavigation,
  isCertificateTrusted,
  isKeyDown,
  parseTrustedCertificates,
  sanitizeBrowserCommand,
  sanitizeCaptureRegion,
  sanitizeCertificateQuery,
  sanitizeClearData,
  sanitizeDevToolsOpen,
  sanitizeNavigate,
  sanitizePrepare,
  serializeTrustedCertificates,
  stepZoomFactor,
  uniqueDownloadName,
  withTrustedCertificate,
  withoutPartitionCertificates,
  workspaceIdOfPartition,
  type GuestKeyInput,
} from "./browser-policy";

const PREPARED = `${BROWSER_PARTITION_PREFIX}ws-1`;
const prepared = (partition: string) => partition === PREPARED;

test("partitions are named per workspace and only for safe ids", () => {
  assert.equal(browserPartitionFor("ws-1"), PREPARED);
  assert.equal(browserPartitionFor("../etc"), null);
  assert.equal(browserPartitionFor(""), null);
  assert.equal(workspaceIdOfPartition(PREPARED), "ws-1");
  assert.equal(workspaceIdOfPartition("persist:other"), null);
  assert.equal(workspaceIdOfPartition(BROWSER_DEVTOOLS_PARTITION), null);
});

test("the gate admits a prepared page partition attaching on about:blank", () => {
  assert.deepEqual(decideWebviewAttach({ preferencesPartition: PREPARED, paramsPartition: PREPARED, src: "about:blank" }, prepared), {
    ok: true,
    kind: "page",
    partition: PREPARED,
    workspaceId: "ws-1",
  });
  // Either source of the partition is enough.
  assert.equal(decideWebviewAttach({ paramsPartition: PREPARED, src: "about:blank" }, prepared).ok, true);
  assert.equal(decideWebviewAttach({ preferencesPartition: PREPARED, src: "about:blank" }, prepared).ok, true);
});

test("the gate rejects unprefixed, unprepared, missing or disagreeing partitions and any other src", () => {
  const reject = (request: Parameters<typeof decideWebviewAttach>[0]) => decideWebviewAttach(request, prepared).ok;
  assert.equal(reject({ paramsPartition: "persist:evil", src: "about:blank" }), false);
  assert.equal(reject({ paramsPartition: "", src: "about:blank" }), false);
  assert.equal(reject({ src: "about:blank" }), false);
  assert.equal(reject({ paramsPartition: `${BROWSER_PARTITION_PREFIX}ws-2`, src: "about:blank" }), false);
  assert.equal(reject({ paramsPartition: `${BROWSER_PARTITION_PREFIX}../x`, src: "about:blank" }), false);
  assert.equal(reject({ preferencesPartition: PREPARED, paramsPartition: `${BROWSER_PARTITION_PREFIX}ws-2`, src: "about:blank" }), false);
  assert.equal(reject({ paramsPartition: PREPARED, src: "https://example.com/" }), false);
  assert.equal(reject({ paramsPartition: PREPARED, src: "" }), false);
  assert.equal(reject({ paramsPartition: PREPARED }), false);
  assert.equal(reject({ paramsPartition: PREPARED, src: "file:///etc/passwd" }), false);
});

test("the DevTools host is admitted only as its own kind, by its own partition", () => {
  assert.deepEqual(decideWebviewAttach({ paramsPartition: BROWSER_DEVTOOLS_PARTITION, src: "about:blank" }, () => false), {
    ok: true,
    kind: "devtools",
    partition: BROWSER_DEVTOOLS_PARTITION,
  });
  assert.equal(decideWebviewAttach({ paramsPartition: BROWSER_DEVTOOLS_PARTITION, src: "devtools://devtools/x" }, () => true).ok, false);
  // A page partition never becomes a DevTools host, and the persistent twin of the name is just a (workspace) page partition.
  const twin = decideWebviewAttach({ paramsPartition: `persist:${BROWSER_DEVTOOLS_PARTITION}`, src: "about:blank" }, () => true);
  assert.equal(twin.ok && twin.kind, "page");
});

test("guest navigation is limited to http(s) and about:blank; the DevTools host to devtools:", () => {
  assert.equal(isAllowedPageNavigation("http://localhost:5173/"), true);
  assert.equal(isAllowedPageNavigation("https://example.com/"), true);
  assert.equal(isAllowedPageNavigation("about:blank"), true);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "coflux-app://app/", "devtools://devtools/x", "data:text/html,x", "mailto:a@b.c", "nonsense"]) {
    assert.equal(isAllowedPageNavigation(url), false, url);
  }
  assert.equal(isAllowedDevToolsNavigation("devtools://devtools/bundled/devtools_app.html"), true);
  assert.equal(isAllowedDevToolsNavigation("about:blank"), true);
  assert.equal(isAllowedDevToolsNavigation("https://example.com/"), false);
});

function key(code: string, modifiers: Partial<GuestKeyInput> = {}): GuestKeyInput {
  return { type: "keyDown", code, meta: true, control: false, alt: false, shift: false, ...modifiers };
}

test("app page shortcuts leave a focused page as commands", () => {
  const command = (input: GuestKeyInput) => {
    const action = classifyGuestKey(input);
    return action?.kind === "command" ? action.command : null;
  };
  assert.equal(command(key("KeyT")), "create-terminal");
  assert.equal(command(key("KeyW")), "close-terminal");
  assert.equal(command(key("KeyN")), "create-workspace");
  assert.equal(command(key("KeyP")), "toggle-palette");
  assert.equal(command(key("BracketLeft")), "previous-tab");
  assert.equal(command(key("BracketRight")), "next-tab");
  assert.equal(command(key("Backslash")), "split-right");
  assert.equal(command(key("IntlBackslash")), "split-right");
  assert.equal(command(key("Backslash", { shift: true })), "split-down");
  assert.equal(command(key("Digit3")), "focus-group-3");
  assert.equal(command(key("Digit3", { alt: true })), "select-tab-3");
  assert.equal(command(key("ArrowLeft", { alt: true })), "focus-group-left");
  assert.equal(command(key("ArrowDown", { alt: true })), "focus-group-down");
  assert.equal(command(key("Slash")), "toggle-help");
  assert.equal(command(key("Comma")), "open-settings");
});

test("browser keys and zoom are the tab's; everything else stays with the page", () => {
  assert.deepEqual(classifyGuestKey(key("KeyL")), { kind: "browser", action: "focus-address" });
  assert.deepEqual(classifyGuestKey(key("KeyI", { alt: true })), { kind: "browser", action: "toggle-devtools" });
  assert.deepEqual(classifyGuestKey(key("Equal")), { kind: "zoom", direction: "in" });
  assert.deepEqual(classifyGuestKey(key("Equal", { shift: true })), { kind: "zoom", direction: "in" });
  assert.deepEqual(classifyGuestKey(key("Minus")), { kind: "zoom", direction: "out" });
  assert.deepEqual(classifyGuestKey(key("Digit0")), { kind: "zoom", direction: "reset" });
  for (const code of ["KeyC", "KeyV", "KeyA", "KeyF", "KeyZ", "KeyR", "ArrowLeft", "Tab"]) {
    assert.equal(classifyGuestKey(key(code)), null, code);
  }
  // Not ⌘ at all, Ctrl in the mix, ⇧⌘W (close window) and ⌘⌥⇧ combinations are not taken.
  assert.equal(classifyGuestKey(key("KeyT", { meta: false })), null);
  assert.equal(classifyGuestKey(key("KeyT", { control: true })), null);
  assert.equal(classifyGuestKey(key("KeyW", { shift: true })), null);
  assert.equal(classifyGuestKey(key("KeyI", { alt: true, shift: true })), null);
  assert.equal(classifyGuestKey(key("Digit0", { alt: true })), null);
  assert.equal(isKeyDown("keyDown"), true);
  assert.equal(isKeyDown("rawKeyDown"), true);
  assert.equal(isKeyDown("keyUp"), false);
});

test("zoom follows Chromium's ladder and stops at its ends", () => {
  assert.equal(stepZoomFactor(1, "in"), 1.1);
  assert.equal(stepZoomFactor(1, "out"), 0.9);
  assert.equal(stepZoomFactor(1.3, "in"), 1.5);
  assert.equal(stepZoomFactor(1.3, "out"), 1.25);
  assert.equal(stepZoomFactor(5, "in"), 5);
  assert.equal(stepZoomFactor(0.25, "out"), 0.25);
  assert.equal(stepZoomFactor(2, "reset"), 1);
});

test("downloads never overwrite and never escape the folder", () => {
  const taken = new Set(["report.pdf", "report (1).pdf", "archive"]);
  assert.equal(uniqueDownloadName("new.txt", (name) => taken.has(name)), "new.txt");
  assert.equal(uniqueDownloadName("report.pdf", (name) => taken.has(name)), "report (2).pdf");
  assert.equal(uniqueDownloadName("archive", (name) => taken.has(name)), "archive (1)");
  assert.equal(uniqueDownloadName("../../etc/passwd", () => false), "_.._etc_passwd");
  assert.equal(uniqueDownloadName("", () => false), "download");
  assert.equal(uniqueDownloadName(".bashrc", () => false), "bashrc");
});

test("trusted certificates are per partition, survive storage and can be forgotten", () => {
  const other = `${BROWSER_PARTITION_PREFIX}ws-2`;
  let store = withTrustedCertificate({}, PREPARED, "Dev.Local", "sha256/abc");
  assert.equal(isCertificateTrusted(store, PREPARED, "dev.local", "sha256/abc"), true);
  assert.equal(isCertificateTrusted(store, PREPARED, "dev.local", "sha256/other"), false);
  assert.equal(isCertificateTrusted(store, other, "dev.local", "sha256/abc"), false);
  assert.equal(withTrustedCertificate(store, PREPARED, "dev.local", "sha256/abc"), store);
  store = withTrustedCertificate(store, other, "x.local", "sha256/x");
  const restored = parseTrustedCertificates(serializeTrustedCertificates(store));
  assert.deepEqual(restored, store);
  const forgotten = withoutPartitionCertificates(restored, PREPARED);
  assert.equal(isCertificateTrusted(forgotten, PREPARED, "dev.local", "sha256/abc"), false);
  assert.equal(isCertificateTrusted(forgotten, other, "x.local", "sha256/x"), true);
  assert.deepEqual(parseTrustedCertificates("{broken"), {});
  assert.deepEqual(parseTrustedCertificates(JSON.stringify({ version: 1, partitions: { "persist:evil": [{ host: "a", fingerprint: "b" }] } })), {});
});

test("IPC payloads are validated field by field", () => {
  assert.deepEqual(sanitizePrepare({ workspaceId: "ws-1", daemonId: "d1" }), { workspaceId: "ws-1", daemonId: "d1" });
  assert.equal(sanitizePrepare({ workspaceId: "../x", daemonId: "d1" }), null);
  assert.equal(sanitizePrepare({ workspaceId: "ws-1", daemonId: 3 }), null);

  assert.deepEqual(sanitizeNavigate({ guestId: 7, url: "http://localhost:3000/" }), { guestId: 7, url: "http://localhost:3000/" });
  assert.equal(sanitizeNavigate({ guestId: 7, url: "file:///etc/passwd" }), null);
  assert.equal(sanitizeNavigate({ guestId: -1, url: "http://a.com/" }), null);
  assert.equal(sanitizeNavigate({ guestId: 1.5, url: "http://a.com/" }), null);

  assert.deepEqual(sanitizeBrowserCommand({ guestId: 7, command: "hard-reload" }), { guestId: 7, command: "hard-reload" });
  assert.equal(sanitizeBrowserCommand({ guestId: 7, command: "executeJavaScript" }), null);

  assert.deepEqual(sanitizeCaptureRegion({ guestId: 7, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } })?.rect, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
  assert.equal(sanitizeCaptureRegion({ guestId: 7, rect: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }), null);
  assert.equal(sanitizeCaptureRegion({ guestId: 7, rect: { x: 0, y: 0, width: 0, height: 0.5 } }), null);

  assert.deepEqual(sanitizeDevToolsOpen({ guestId: 7, hostGuestId: 8 }), { guestId: 7, hostGuestId: 8 });
  assert.equal(sanitizeDevToolsOpen({ guestId: 7, hostGuestId: 7 }), null);

  assert.deepEqual(sanitizeClearData({ workspaceId: "ws-1", target: "cookies" }), { workspaceId: "ws-1", target: "cookies" });
  assert.equal(sanitizeClearData({ workspaceId: "ws-1", target: "everything" }), null);

  assert.deepEqual(sanitizeCertificateQuery({ guestId: 7, host: "Dev.Local" }), { guestId: 7, host: "dev.local" });
  assert.equal(sanitizeCertificateQuery({ guestId: 7, host: "a b" }), null);
});

test("a region is cropped in the frozen frame's pixels, clamped inside it", () => {
  assert.deepEqual(cropRectInPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, { width: 800, height: 600 }), { x: 200, y: 300, width: 400, height: 150 });
  assert.deepEqual(cropRectInPixels({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }, { width: 100, height: 100 }), { x: 90, y: 90, width: 10, height: 10 });
  assert.equal(cropRectInPixels({ x: 0.5, y: 0.5, width: 0.001, height: 0.001 }, { width: 100, height: 100 }), null);
});
