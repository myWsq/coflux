import assert from "node:assert/strict";
import { test } from "node:test";

import { createRendererResetListener, type RendererNavigation } from "./renderer-reset";

const TRUSTED = { appOrigin: "coflux-app://app", devRendererUrl: "http://localhost:5274/" };

/** What `did-navigate` produces for a reload or the initial load of the packaged renderer. */
const RELOAD: RendererNavigation = { url: "coflux-app://app/", isMainFrame: true, isSameDocument: false };

/**
 * Stands in for `NativeTailcatTransport`, modelling exactly what `close()` has to undo: the helper
 * subprocess, the control connection and the open lanes. The real class cannot be driven here
 * without a central server and a helper binary, and this plan is about *when* close is called.
 */
class FakeTransport {
  helperRunning = false;
  controlOpen = false;
  lanes: string[] = [];
  closes = 0;

  /** Bring it up the way a live page does. */
  start(...lanes: string[]): void {
    this.helperRunning = true;
    this.controlOpen = true;
    this.lanes.push(...lanes);
  }

  close(): void {
    this.closes += 1;
    this.helperRunning = false;
    this.controlOpen = false;
    this.lanes = [];
  }

  snapshot(): { helperRunning: boolean; controlOpen: boolean; lanes: string[] } {
    return { helperRunning: this.helperRunning, controlOpen: this.controlOpen, lanes: [...this.lanes] };
  }
}

/**
 * Stands in for the executor host's channel half, **including its dedupe** — `setChannel` returns
 * early when the announced id equals the retained one, and only a non-empty id registers. The real
 * `createExecutorHost` cannot be imported from a `node --test` file (executor-host.ts imports
 * `electron`, whose package entry is a path string with no named exports), so the contract is
 * mirrored here; see executor-host.ts's `setChannel`.
 *
 * `jobs` is here to be asserted *unchanged*: a reset must produce the state a genuine channel drop
 * produces — the runner lives in the main process and keeps going, and re-dispatching a writer would
 * double-write.
 */
class FakeExecutorHost {
  registers: { daemonId: string; epoch: number }[] = [];
  jobs = ["run-1"];
  channel = "";
  private epoch = 0;

  setChannel(daemonId: string): void {
    if (daemonId === this.channel) return;
    this.channel = daemonId;
    if (!daemonId) return;
    this.epoch += 1;
    this.registers.push({ daemonId, epoch: this.epoch });
  }
}

/** Stands in for `setDockBadge`, which keeps its count in main-process module scope. */
class FakeDock {
  count = 0;
  calls: number[] = [];

  setBadge(count: number): void {
    this.calls.push(count);
    this.count = count;
  }
}

function fixture() {
  const transport = new FakeTransport();
  const executor = new FakeExecutorHost();
  const dock = new FakeDock();
  const listener = createRendererResetListener(
    {
      closeTransport: () => transport.close(),
      resetExecutorChannel: () => executor.setChannel(""),
      setBadge: (count) => dock.setBadge(count),
    },
    TRUSTED,
  );
  /** The state a page that has been running for a while leaves in the main process. */
  const live = () => {
    transport.start("lane-session-read", "lane-session-control");
    executor.setChannel("daemon-1");
    dock.setBadge(3);
  };
  return { transport, executor, dock, listener, live };
}

test("(a) the first navigation, with nothing open, changes nothing", () => {
  const { transport, executor, dock, listener } = fixture();

  listener(RELOAD);

  // The reset does run — the initial `loadURL` fires the same event a reload does, and there is
  // deliberately no "have we loaded once" flag. Every step is a no-op in this state instead.
  assert.equal(transport.closes, 1);
  assert.deepEqual(transport.snapshot(), { helperRunning: false, controlOpen: false, lanes: [] });
  assert.equal(executor.channel, "");
  assert.deepEqual(executor.registers, []);
  assert.equal(dock.count, 0);
});

test("(b) a reload closes the transport, drops the executor channel and zeroes the badge", () => {
  const { transport, executor, dock, listener, live } = fixture();
  live();

  listener(RELOAD);

  assert.deepEqual(transport.snapshot(), { helperRunning: false, controlOpen: false, lanes: [] });
  assert.equal(executor.channel, "");
  assert.equal(dock.count, 0);
  // The job table is not the renderer's: the runner is still going, and reconciliation restores the
  // state when the new page re-announces the channel.
  assert.deepEqual(executor.jobs, ["run-1"]);
});

test("(b) the dev renderer's own URL is reset the same way", () => {
  const { transport, executor, dock, listener, live } = fixture();
  live();

  listener({ url: "http://localhost:5274/", isMainFrame: true, isSameDocument: false });

  assert.deepEqual(transport.snapshot(), { helperRunning: false, controlOpen: false, lanes: [] });
  assert.equal(executor.channel, "");
  assert.equal(dock.count, 0);
});

test("(b) reloading repeatedly does not accumulate anything", () => {
  const { transport, executor, dock, listener, live } = fixture();

  for (let i = 0; i < 10; i++) {
    live();
    listener(RELOAD);
    assert.deepEqual(transport.snapshot(), { helperRunning: false, controlOpen: false, lanes: [] });
    assert.equal(executor.channel, "");
    assert.equal(dock.count, 0);
  }
  // Ten pages came and went; the page that is up now announced its channel exactly once each time.
  assert.equal(executor.registers.length, 10);
});

test("(c) a navigation that never rebuilds the trusted page resets nothing", () => {
  const cases: [string, RendererNavigation][] = [
    // The `did-start-navigation` trap: `will-navigate` cancels an external link and hands it to the
    // system browser, but a start-navigation event has already fired with this exact shape.
    ["an external link handed to the system browser", { url: "https://example.com/oauth/consent", isMainFrame: true, isSameDocument: false }],
    ["another app's custom scheme", { url: "coflux-app://evil/", isMainFrame: true, isSameDocument: false }],
    ["an in-page navigation", { url: "coflux-app://app/#terminal-2", isMainFrame: true, isSameDocument: true }],
    ["a subframe navigation", { url: "coflux-app://app/", isMainFrame: false, isSameDocument: false }],
    ["no URL at all", { url: "", isMainFrame: true, isSameDocument: false }],
  ];

  for (const [label, navigation] of cases) {
    const { transport, executor, dock, listener, live } = fixture();
    live();

    listener(navigation);

    assert.equal(transport.closes, 0, label);
    assert.deepEqual(transport.snapshot(), { helperRunning: true, controlOpen: true, lanes: ["lane-session-read", "lane-session-control"] }, label);
    assert.equal(executor.channel, "daemon-1", label);
    assert.equal(dock.count, 3, label);
  }
});

test("(d) regression guard: after a reset the same daemonId registers again", () => {
  // This passes on the untouched baseline too — the renderer sends `setExecutorChannel("")` before
  // any daemon id on every mount, so the re-announcement already slips past the host's dedupe. It is
  // here to catch a future change to that mount order (use-executor-bridge.ts) or to the dedupe
  // (executor-host.ts's `setChannel`), either of which would silently stop the re-registration.
  const { executor, listener, live } = fixture();
  live();
  assert.deepEqual(executor.registers, [{ daemonId: "daemon-1", epoch: 1 }]);

  listener(RELOAD);
  // The new page announces the same machine's daemon, since nothing about the machine changed.
  executor.setChannel("daemon-1");

  assert.deepEqual(executor.registers, [
    { daemonId: "daemon-1", epoch: 1 },
    { daemonId: "daemon-1", epoch: 2 },
  ]);
});

test("(e) a reload resets the browser host's per-guest state; an in-page or foreign navigation does not", () => {
  let resets = 0;
  const listener = createRendererResetListener(
    {
      closeTransport: () => undefined,
      resetExecutorChannel: () => undefined,
      setBadge: () => undefined,
      resetBrowserHost: () => {
        resets += 1;
      },
    },
    TRUSTED,
  );
  listener(RELOAD);
  assert.equal(resets, 1);
  listener({ ...RELOAD, isSameDocument: true });
  listener({ url: "https://example.com/", isMainFrame: true, isSameDocument: false });
  assert.equal(resets, 1);
});
