import type { AuthState, ConnectionStatus } from "@coflux/client";
import { TaskStatus, type Task } from "@coflux/protocol";

import type { DesktopDaemonBusy, DesktopDaemonState } from "@/desktop-bridge";

/**
 * 本机终端（plan 113）在渲染层的纯展示映射：状态对象 → 账号菜单一行的文案 / 面板里的可见动作 /
 * 接入引导当前该在哪一页、三步各是什么态。全是纯函数（照 account-footer-view.ts 先例），便于 node --test；
 * JSX 里不散 switch。
 */

export type DaemonTone = "success" | "warning" | "error" | "accent" | "neutral";

export type DaemonStatusLine = {
  /** 状态短语：运行中 / 已停止 / 等待授权 / 有更新待重启 / 未接入 / 进行中动作 */
  label: string;
  /** 补充说明（FDA 未授予、版本、失败原因等）；无则空串 */
  detail: string;
  tone: DaemonTone;
  /** 进行中（动作 / 等待授权）时状态点脉动 */
  pulsing: boolean;
};

export const DAEMON_BUSY_LABEL: Record<DesktopDaemonBusy, string> = {
  install: "安装组件",
  start: "启动服务",
  restart: "重启服务",
  stop: "停止服务",
  remove: "移除接入",
};

export function daemonStatusLine(state: DesktopDaemonState): DaemonStatusLine {
  if (state.busy) return { label: `正在${DAEMON_BUSY_LABEL[state.busy]}…`, detail: "", tone: "accent", pulsing: true };
  const failure = state.error ? `${DAEMON_BUSY_LABEL[state.error.action]}失败：${state.error.message}` : "";
  switch (state.status) {
    case "not-installed":
      return {
        label: "未接入",
        detail: failure || (state.bundled ? "这台 Mac 还没接入 coflux" : "本构建不带内置 daemon，用 npm i -g cofluxd && cofluxd up 接入"),
        tone: failure ? "error" : "neutral",
        pulsing: false,
      };
    case "stopped":
      return { label: "已停止", detail: failure, tone: failure ? "error" : "warning", pulsing: false };
    case "pending-auth":
      return {
        label: "等待授权",
        detail: failure || (state.authToken ? "用当前登录账号即可完成" : "正在获取授权链接…"),
        tone: failure ? "error" : "accent",
        pulsing: !failure,
      };
    case "update-ready":
      return {
        label: "有更新待重启",
        detail: failure || `内置 ${state.bundledVersion ?? ""}，在跑 ${state.runningVersion ?? "未知版本"}`,
        tone: failure ? "error" : "warning",
        pulsing: false,
      };
    case "running":
      if (failure) return { label: "运行中", detail: failure, tone: "error", pulsing: false };
      if (state.fda !== "granted") return { label: "运行中", detail: "未授予完全磁盘访问", tone: "warning", pulsing: false };
      return { label: "运行中", detail: "", tone: "success", pulsing: false };
  }
}

export type DaemonActionId = "enroll" | "authorize" | "start" | "restart" | "update" | "stop" | "remove" | "fda";

export type DaemonAction = {
  id: DaemonActionId;
  label: string;
  kind: "primary" | "secondary" | "destructive";
  /** 需要二次确认的动作带确认框文案；无则直接执行 */
  confirm?: { title: string; description: string; confirmLabel: string };
};

/** 「会结束本机 N 个终端」：重启 / 停止 / 换新的后果说明。 */
export function terminalsImpact(runningTerminals: number): string {
  return runningTerminals > 0 ? `会结束本机 ${runningTerminals} 个正在运行的终端及其中的程序。` : "本机当前没有正在运行的终端。";
}

const REMOVE_CONFIRM = {
  title: "移除这台 Mac 的接入？",
  description: "会停止本机终端并暂停接入，项目文件不受影响。",
  confirmLabel: "移除接入",
};

/**
 * 面板里的可见动作。busy 期间无动作；FDA 引导只在运行且未授予时出现；
 * 运行中有终端时重启 / 停止要确认，「重启并更新」永远要确认（文案带终端数）。
 */
export function resolveDaemonActions(state: DesktopDaemonState, runningTerminals: number): DaemonAction[] {
  if (state.busy) return [];
  const impact = terminalsImpact(runningTerminals);
  const stop: DaemonAction = {
    id: "stop",
    label: "停止",
    kind: "secondary",
    ...(runningTerminals > 0 ? { confirm: { title: "停止本机终端？", description: impact, confirmLabel: "停止" } } : {}),
  };
  const remove: DaemonAction = { id: "remove", label: "移除接入", kind: "destructive", confirm: REMOVE_CONFIRM };
  const fda: DaemonAction[] = state.fda === "granted" ? [] : [{ id: "fda", label: "完全磁盘访问…", kind: "secondary" }];
  switch (state.status) {
    case "not-installed":
      return state.bundled ? [{ id: "enroll", label: "接入这台 Mac", kind: "primary" }] : [];
    case "stopped":
      return [{ id: "start", label: "启动", kind: "primary" }, remove];
    case "pending-auth":
      return [{ id: "authorize", label: "授权", kind: "primary" }, { id: "restart", label: "重启", kind: "secondary" }, stop, remove];
    case "running":
      return [
        ...fda,
        {
          id: "restart",
          label: "重启",
          kind: "secondary",
          ...(runningTerminals > 0 ? { confirm: { title: "重启本机终端？", description: impact, confirmLabel: "重启" } } : {}),
        },
        stop,
        remove,
      ];
    case "update-ready":
      return [
        {
          id: "update",
          label: "重启并更新",
          kind: "primary",
          confirm: {
            title: `更新本机终端 到 ${state.bundledVersion ?? "内置版本"}？`,
            description: `${impact} 更新只在你点这里时发生，从不自动重启。`,
            confirmLabel: "重启并更新",
          },
        },
        ...fda,
        stop,
        remove,
      ];
  }
}

/** 本机运行中终端数：按 credentials.json 的 daemonId 匹配本设备、数 RUNNING 的 task。 */
export function countLocalRunningTerminals(tasks: readonly Task[], daemonId: string | undefined): number {
  if (!daemonId) return 0;
  return tasks.filter((task) => task.daemonId === daemonId && task.status === TaskStatus.RUNNING).length;
}

/**
 * 登录成功后是否自动弹接入引导：中心已连上（离线冷启动的 authed 来自缓存，不弹）、本机未接入、
 * 本构建带 daemon、没点过「暂不」、这次登录还没弹过。
 */
export function shouldOfferOnboarding(input: {
  authState: AuthState;
  connection: ConnectionStatus;
  state: DesktopDaemonState | null;
  dismissed: boolean;
  alreadyOffered: boolean;
}): boolean {
  if (input.authState !== "authed" || input.connection !== "connected") return false;
  if (!input.state || input.state.status !== "not-installed" || !input.state.bundled) return false;
  return !input.dismissed && !input.alreadyOffered;
}

export type OnboardingPage = "intro" | "progress" | "fda" | "done";
export type OnboardingStepState = "pending" | "active" | "done" | "failed";

export type OnboardingLocal = {
  /** 点过「接入」（或从账号菜单以已开始的状态进入） */
  started: boolean;
  /** authorizeDevice 的失败原因；null = 没失败 */
  authError: string | null;
  /** FDA 页点过「我已勾选，重启服务」或「跳过」 */
  fdaSettled: boolean;
};

export function resolveOnboardingPage(state: DesktopDaemonState, local: OnboardingLocal): OnboardingPage {
  // 已登记就到了 FDA / 完成：重启中短暂的「已停止」不该把人打回进度页
  if (state.registered && state.installed) return local.fdaSettled || state.fda === "granted" ? "done" : "fda";
  if (!local.started && state.status === "not-installed") return "intro";
  return "progress";
}

export type OnboardingSteps = {
  install: OnboardingStepState;
  start: OnboardingStepState;
  authorize: OnboardingStepState;
  /** 当前失败的那一步的红字；无则 null */
  failure: string | null;
  /** 重试该做什么：重新接入（覆盖落盘 + 重新 load）/ 重新授权；无失败为 null */
  retry: "enroll" | "authorize" | null;
};

export function resolveOnboardingSteps(state: DesktopDaemonState, local: OnboardingLocal): OnboardingSteps {
  const error = state.error;
  let install: OnboardingStepState = "pending";
  if (error?.action === "install") install = "failed";
  else if (state.busy === "install") install = "active";
  else if (state.installed) install = "done";
  else if (local.started) install = "active";

  let start: OnboardingStepState = "pending";
  if (error?.action === "start") start = "failed";
  else if (state.running) start = "done";
  else if (state.busy === "start") start = "active";
  else if (install === "done" && !state.busy && !error) start = "active"; // launchctl load 之后等 pid 出现

  let authorize: OnboardingStepState = "pending";
  if (state.registered) authorize = "done";
  else if (start === "done") authorize = local.authError ? "failed" : "active";

  const failure =
    error && (error.action === "install" || error.action === "start")
      ? `${DAEMON_BUSY_LABEL[error.action]}失败：${error.message}`
      : authorize === "failed"
        ? `授权失败：${local.authError}`
        : null;
  const retry = failure ? (authorize === "failed" ? "authorize" : "enroll") : null;
  return { install, start, authorize, failure, retry };
}

/** 等待授权时的一行说明：有 token 就是「授权中…」，没有就是等 daemon 落盘链接。 */
export function authorizeStepDetail(state: DesktopDaemonState, local: OnboardingLocal): string {
  if (state.registered) return "已用当前登录账号完成";
  if (local.authError) return local.authError;
  return state.authToken ? "授权中…（用当前登录账号）" : "正在连接账号服务器…";
}
