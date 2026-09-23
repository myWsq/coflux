import type { ConnectionStatus } from "@coflux/client";

import type { DesktopDaemonState } from "@/desktop-bridge";

/**
 * 添加设备 dialog (plan 20260923-add-device-dialog, join keys since plan 20260924-device-join-keys):
 * the React-free parts — the agent prompt, the manual command, the key countdown, the pinned download
 * URL, the new-device diff and the this-Mac row condition. Kept pure so they run under node --test
 * like daemon-view.ts.
 */

/** The arm64 dmg of exactly this app's version (release tag is always `v<product version>`). */
export function desktopDownloadUrl(version: string): string {
  return `https://github.com/myWsq/coflux/releases/download/v${version}/coflux-${version}-arm64.dmg`;
}

/** Manual headless install, for people who would rather type it themselves. The one-time join key is
 * part of the command: running it joins the account, nothing is pasted back. */
export function manualInstallCommand(daemonUrl: string, joinKey: string): string {
  return `npm i -g cofluxd && cofluxd up --server ${daemonUrl} --key ${joinKey}`;
}

/**
 * The prompt handed to an agent on the target machine — deliberately short. `daemonUrl` is
 * `daemonServerUrl(SERVER_URL)`, always passed explicitly so a non-default server can never be
 * silently skipped. It never mentions authorization links, not even as a fallback: with a key the
 * command either joins or fails with a reason.
 */
export function headlessAgentPrompt(daemonUrl: string, joinKey: string): string {
  return `Please connect this machine to my Coflux account:
1. Make sure Node.js 20 or newer is installed (\`node --version\`); if it is missing or older, install it.
2. Run \`npm i -g cofluxd\`.
3. Run \`cofluxd up --server ${daemonUrl} --key ${joinKey}\` (it can take up to about two minutes).
4. Run \`cofluxd status\` and confirm it shows this machine as registered (凭证: 已登记).
If a command fails, stop and tell me its error.`;
}

/** Whole minutes left on a join key, rounded up (a key with 30 s left still reads "1 分钟"); 0 once expired. */
export function joinKeyMinutesLeft(expiresAt: number, now: number): number {
  const left = expiresAt - now;
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

/**
 * Device ids known when the dialog started watching. `null` means no baseline yet; until one exists
 * nothing counts as new.
 */
export type DeviceBaseline = ReadonlySet<string> | null;

/**
 * Baseline capture for one opening of the dialog. The baseline is only ever taken from live data:
 * `status` turns "connected" at WebSocket open, before authOk and before the state snapshot, and the
 * snapshot replaces the whole `daemons` list (possibly an offline-catalogue list or `[]` until then).
 * Snapping at the status flip would make every existing device look new once the snapshot lands.
 *
 * - Opened while connected with some list already present: snap immediately (the authOk →
 *   snapshot gap after a reconnect is negligible, and the list kept across it is the account's).
 * - Opened while connected before any list arrived: wait for the first different array, as below.
 * - Opened while not connected: when the status flips to connected, remember the `daemons` array
 *   reference seen at that moment, and snap on the first *different* array — a snapshot always
 *   assigns a fresh array, so the reference changes exactly when live data arrives.
 * - Dropping out of connected before that resets the wait.
 */
export type BaselineTracker<T extends { daemonId: string } = { daemonId: string }> = {
  baseline: DeviceBaseline;
  /** The `daemons` reference present when the status became connected; null while not waiting. */
  daemonsAtConnect: readonly T[] | null;
};

function idsOf(daemons: readonly { daemonId: string }[]): ReadonlySet<string> {
  return new Set(daemons.map((daemon) => daemon.daemonId));
}

/**
 * Tracker for a fresh opening of the dialog. `hasData` is `snapshotRevision > 0`: not proof of live
 * data (offline-catalogue hydration bumps it too), but 0 reliably means no list of any kind has
 * arrived yet — e.g. a cold start whose boot overlay lifted before the first snapshot. Connected
 * without data waits for the next list instead of snapping `[]`.
 */
export function startBaselineTracker<T extends { daemonId: string }>(status: ConnectionStatus, daemons: readonly T[], hasData: boolean): BaselineTracker<T> {
  if (status !== "connected") return { baseline: null, daemonsAtConnect: null };
  return hasData ? { baseline: idsOf(daemons), daemonsAtConnect: null } : { baseline: null, daemonsAtConnect: daemons };
}

/**
 * Feed the latest status / list. Returns the same object when nothing changes, so it can drive
 * `setState` from an effect without looping. An existing baseline is never replaced.
 */
export function advanceBaselineTracker<T extends { daemonId: string }>(
  tracker: BaselineTracker<T>,
  status: ConnectionStatus,
  daemons: readonly T[],
): BaselineTracker<T> {
  if (tracker.baseline !== null) return tracker;
  if (status !== "connected") return tracker.daemonsAtConnect === null ? tracker : { baseline: null, daemonsAtConnect: null };
  if (tracker.daemonsAtConnect === null) return { baseline: null, daemonsAtConnect: daemons };
  if (tracker.daemonsAtConnect === daemons) return tracker;
  return { baseline: idsOf(daemons), daemonsAtConnect: null };
}

/**
 * Devices whose id was not in the baseline. Ids, not online flags: a device that went offline and
 * came back is not new, while every authorization mints a fresh device id. No baseline → nothing is new.
 */
export function newDevices<T extends { daemonId: string }>(baseline: DeviceBaseline, daemons: readonly T[]): T[] {
  if (baseline === null) return [];
  return daemons.filter((daemon) => !baseline.has(daemon.daemonId));
}

/**
 * The 「这台 Mac 尚未接入」 row: only a bundled build whose local daemon was never installed.
 * `stopped` / `pending-auth` are installed already, and without the bundle the onboarding's
 * 接入 button is disabled.
 */
export function showThisMacRow(state: DesktopDaemonState | null | undefined): boolean {
  return state != null && state.bundled && state.status === "not-installed";
}
