import type { ConnectionStatus } from "@coflux/client";

import type { DesktopDaemonState } from "@/desktop-bridge";

import { authorizeTokenFromUrl } from "../../../shared/daemon-urls";

/**
 * 添加设备 dialog (plan 20260923-add-device-dialog): the React-free parts — paste-input validation,
 * the agent prompt, the manual command, the pinned download URL, the new-device diff and the
 * this-Mac row condition. Kept pure so they run under node --test like daemon-view.ts.
 */

/** Server token shape: `genToken("cf_authz")` → `cf_authz_<base64url>` (apps/server/src/secrets.ts). */
const AUTHORIZE_TOKEN_SHAPE = /^cf_authz_[A-Za-z0-9_-]+$/;

declare const authorizeTokenBrand: unique symbol;

/**
 * A device authorization token that passed `parseAuthorizeInput`. Only the validator mints this
 * type, and the dialog's send path accepts nothing else, so unvalidated text never reaches
 * `client.authorizeDevice`: every rejected token counts against the connection's failure budget,
 * which this Mac's own automatic local authorization shares.
 */
export type AuthorizeToken = string & { readonly [authorizeTokenBrand]: true };

export type AuthorizeInputResult = { ok: true; token: AuthorizeToken } | { ok: false; error: string };

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pasted text → token. A URL goes through `authorizeTokenFromUrl` (anchored on `/authorize/<token>`,
 * trailing slash / query / fragment stripped, URL-decoded); anything else is taken as a bare token.
 * Either way the result must have the server's `cf_authz_` shape. Nothing is sent on failure.
 */
export function parseAuthorizeInput(raw: string): AuthorizeInputResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: "请粘贴授权链接" };
  const isUrl = parsesAsUrl(input);
  const token = isUrl ? authorizeTokenFromUrl(input) : input;
  if (token === null) return { ok: false, error: "这不是授权链接：链接应形如 https://…/authorize/cf_authz_…" };
  if (!AUTHORIZE_TOKEN_SHAPE.test(token)) {
    return { ok: false, error: isUrl ? "授权链接格式不对，请完整复制 cofluxd 打印的链接" : "无法识别：请粘贴完整的授权链接，或以 cf_authz_ 开头的 token" };
  }
  return { ok: true, token: token as AuthorizeToken };
}

/** The arm64 dmg of exactly this app's version (release tag is always `v<product version>`). */
export function desktopDownloadUrl(version: string): string {
  return `https://github.com/myWsq/coflux/releases/download/v${version}/coflux-${version}-arm64.dmg`;
}

/** Manual headless install, for people who would rather type it themselves. */
export function manualInstallCommand(daemonUrl: string): string {
  return `npm i -g cofluxd && cofluxd up --server ${daemonUrl}`;
}

/**
 * The prompt handed to an agent on the target machine. `daemonUrl` is `daemonServerUrl(SERVER_URL)`,
 * always passed explicitly so a non-default server can never be silently skipped.
 */
export function headlessAgentPrompt(daemonUrl: string): string {
  return `Please install the Coflux daemon (cofluxd) on this machine and connect it to my Coflux account.

Ground rules:
- Never use sudo on your own. If any step seems to need root, stop and ask me first.
- Wherever a step says "stop and ask", wait for my answer before continuing.

Steps:
1. Check Node.js: run \`node --version\`. It must be Node.js 20 or newer. If Node.js is missing or older than 20, stop and ask me how I want to install it.
2. Check that the npm global prefix is writable by the current user: run \`npm config get prefix\` and test that directory, e.g. \`test -w "$(npm config get prefix)" && echo writable\`. If it is not writable, stop and ask me how to proceed (do not use sudo).
3. Install: \`npm i -g cofluxd\`
4. Start the daemon: \`cofluxd up --server ${daemonUrl}\`
   On first run this downloads the daemon binaries, installs and starts a background service, prints an authorization link, and then blocks in the foreground for up to 11 minutes waiting for authorization. Do not sit waiting on it. Run it in the background, e.g. \`nohup cofluxd up --server ${daemonUrl} > /tmp/cofluxd-up.log 2>&1 &\`, or with a generous timeout that leaves room for the download, e.g. \`timeout 300 cofluxd up --server ${daemonUrl}\` on Linux. When it is cut short, a timeout or non-zero exit is expected and is not a failure: the service keeps running and keeps the link fresh.
5. Get the link: run \`cofluxd status\` every few seconds until its output contains a URL with \`/authorize/\` (or shows 凭证: 已登记, meaning it is already authorized). If \`up\` exited with a real error before the service was installed, show me /tmp/cofluxd-up.log (or the error) instead. Give me the link and ask me to paste it into the 添加设备 (Add device) dialog in the Coflux desktop app (Headless tab). Opening it in a browser signed in to the same account also works.
6. After I say I have authorized it, run \`cofluxd status\` again and confirm the device shows as registered (凭证: 已登记) and the service is running. If it still shows an /authorize/ link, the previous one may have expired: give me the new link.
7. Linux only: the daemon runs as a \`systemctl --user\` service, which stops when I log out unless lingering is enabled. Ask me before running \`loginctl enable-linger "$USER"\`; do not run it without my confirmation.`;
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
