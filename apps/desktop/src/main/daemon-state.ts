import type { DesktopDaemonBusy, DesktopDaemonFda, DesktopDaemonState, DesktopDaemonStatus } from "../shared/desktop-bridge";
import type { PendingAuth } from "./daemon-files";
import { bundledSupervisorIsNewer } from "./daemon-version";

/**
 * 本机 daemon 状态派生（plan 113）：把 ~/.coflux / LaunchAgent / launchctl 的事实合成渲染层消费的一个对象。
 * 判定移植 cofluxd.mjs 的 cmdStatus：plist 与两个二进制都在 = 已接入（不分 npm / app 来源）；
 * credentials.json 在 = 已登记，否则 pending-auth.json 里的链接 = 等待授权；launchctl 有活 pid = 在跑。
 * 纯函数，无 Electron 依赖。
 */
export type DaemonFacts = {
  /** 内置三件；null = 本构建不带 daemon。version 是 VERSION sidecar 原文（可能是 dev） */
  bundle: { version: string | null } | null;
  installationExists: boolean;
  updateReadyOverride?: boolean;
  supervisorExists: boolean;
  workerExists: boolean;
  /** credentials.json 存在 */
  registered: boolean;
  daemonId: string | null;
  pendingAuth: PendingAuth | null;
  running: boolean;
  fda: DesktopDaemonFda;
  /** ~/.coflux/supervisor-version 原文；缺失 null */
  runningVersion: string | null;
  binDir: string;
  busy?: DesktopDaemonBusy;
  error?: { action: DesktopDaemonBusy; message: string };
};

export function deriveDaemonStatus(facts: Pick<DaemonFacts, "installationExists" | "supervisorExists" | "workerExists" | "registered" | "running"> & { updateReady: boolean }): DesktopDaemonStatus {
  const installed = facts.installationExists && facts.supervisorExists && facts.workerExists;
  if (!installed) return "not-installed";
  if (!facts.running) return "stopped";
  if (!facts.registered) return "pending-auth";
  return facts.updateReady ? "update-ready" : "running";
}

export function deriveDaemonState(facts: DaemonFacts): DesktopDaemonState {
  const installed = facts.installationExists && facts.supervisorExists && facts.workerExists;
  const updateReady = facts.updateReadyOverride ?? (facts.bundle !== null && bundledSupervisorIsNewer(facts.bundle.version, facts.runningVersion));
  const state: DesktopDaemonState = {
    status: deriveDaemonStatus({ ...facts, updateReady }),
    bundled: facts.bundle !== null,
    installed,
    running: facts.running,
    registered: facts.registered,
    fda: facts.fda,
    binDir: facts.binDir,
  };
  if (facts.bundle?.version) state.bundledVersion = facts.bundle.version;
  if (facts.runningVersion) state.runningVersion = facts.runningVersion;
  if (facts.daemonId) state.daemonId = facts.daemonId;
  // 已登记后 token 没有意义（daemon 兑现后会清文件；这里再兜一层，不把过期链接漏给渲染层）
  if (!facts.registered && facts.pendingAuth) {
    state.authToken = facts.pendingAuth.token;
    if (facts.pendingAuth.expiresAt !== undefined) state.authExpiresAt = facts.pendingAuth.expiresAt;
  }
  if (facts.busy) state.busy = facts.busy;
  if (facts.error) state.error = facts.error;
  return state;
}
