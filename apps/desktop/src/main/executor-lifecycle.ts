/**
 * When an executor run must be cancelled — the whole decision, as one pure function.
 *
 * Executor runs live in the desktop main process, so anything that looks like "the local runtime is
 * going away" could plausibly end them. Only one class of event actually should: a local runtime
 * stop the user **confirmed**. Everything else leaves running jobs alone, and the difference
 * matters because cancellation is irreversible — a half-written file cannot be un-written.
 *
 * Kept out of `daemon-manager` and `index.ts` deliberately: both are Electron-bound, and this is the
 * part worth exhaustively testing.
 */

import type { StopReason } from "./daemon-manager";

/** Every situation that reaches the executor host looking like a shutdown. */
export type ExecutorStopTrigger =
  /**
   * The daemon manager finished a `stopConfirmed(reason)` pass. `confirmed` is its return value:
   * false means the user dismissed the confirmation dialog and nothing was stopped.
   */
  | { kind: "runtime-stop"; reason: StopReason; confirmed: boolean }
  /**
   * The app is genuinely on its way out: the committed (`quitting`) `before-quit` pass. This also
   * covers quit-and-install, which sets `quitting` itself and never goes through `stopConfirmed`.
   */
  | { kind: "app-exit" }
  /**
   * The device channel to the local daemon dropped. **Never** a reason to cancel: a dropped channel
   * does not mean the app died, the jobs are still running, and the reconcile design (no writer
   * re-dispatch, `unknown` for runs the host cannot account for) depends on them surviving.
   */
  | { kind: "device-channel-lost" };

/**
 * The sentence to record on the cancelled runs, or `null` to leave them running.
 *
 * The text ends up in the CLI's stderr, so it says which user action ended the job — Chinese, like
 * the rest of the product's user-facing strings.
 */
export function executorCancelReason(trigger: ExecutorStopTrigger): string | null {
  if (trigger.kind === "app-exit") return "桌面 app 退出，任务被中断";
  // A dropped channel is transient by assumption; reconnecting reconciles the run list instead.
  if (trigger.kind === "device-channel-lost") return null;
  // The user dismissed the dialog: nothing was stopped, so nothing may be cancelled.
  if (!trigger.confirmed) return null;
  switch (trigger.reason) {
    case "quit":
      return "退出 Coflux，任务被中断";
    case "logout":
      return "退出登录，任务被中断";
    // The panel's "stop" and "remove" both stop the runtime under this reason; both end the
    // machine the executor's tool processes run on, so both cancel.
    case "stop":
      return "本机终端已停止，任务被中断";
    // A restart brings the same runtime straight back and the app never goes away. Cancelling here
    // would destroy work for what the user experiences as a blip.
    case "restart":
      return null;
    // Taking over a legacy LaunchAgent installation. It stops the *old* daemon, not this app, and
    // no executor run is hosted there.
    case "migrate":
      return null;
  }
}
