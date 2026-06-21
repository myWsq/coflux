/** daemon 配置：环境变量集中、带默认值。 */
import os from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "@coflux/protocol";

const home = process.env.COFLUX_HOME ?? join(os.homedir(), ".coflux");

export const config = {
  serverUrl: process.env.COFLUX_SERVER ?? `ws://localhost:${DEFAULT_PORT}/daemon`,
  enrollKey: process.env.COFLUX_ENROLL_KEY ?? "dev-enroll",
  deviceName: process.env.COFLUX_DEVICE_NAME ?? os.hostname(),
  home,
  credPath: join(home, "credentials.json"),
  worktreesDir: join(home, "worktrees"),
  shell: process.env.COFLUX_SHELL ?? process.env.SHELL ?? "/bin/bash",

  scrollbackLimit: 200_000,
  maxSessions: 200,
  heartbeatMs: 30_000,
  authDeadlineMs: 15_000,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 30_000,
  ptyPauseHigh: 4 * 1024 * 1024,
  ptyResumeLow: 1 * 1024 * 1024,
} as const;
