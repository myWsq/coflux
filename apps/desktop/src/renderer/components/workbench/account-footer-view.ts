import type { DesktopUpdateState } from "@/desktop-bridge";

/**
 * 侧栏底部账号脚部（plan 110）的纯展示映射：身份行怎么显示、服务器 host 怎么取、
 * 更新状态怎么变成「尾部按钮种类 + 一条菜单项」。全是纯函数，便于 node --test
 * （与同目录 desktop-update.ts 的 resolveOutdatedPrompt 同一做法：不在 JSX 里散 switch）。
 */

/** 身份未知时的占位：旧 server 不回 login_name、离线冷启动缓存里没有——都不得留白 */
export const ACCOUNT_IDENTITY_PLACEHOLDER = "已登录";

export type AccountIdentity = {
  /** 第一行文案 */
  label: string;
  /** 传给 Astryx Avatar 的 name（出 initials）；undefined = 走默认人形图标 */
  avatarName: string | undefined;
  /** true = 身份未知，显示的是占位文案 */
  isPlaceholder: boolean;
};

/** 登录身份显示：email 取 `@` 前部分做头像 initials；空串（旧 server / 旧缓存）退回占位。 */
export function accountIdentity(loginName: string): AccountIdentity {
  const name = loginName.trim();
  if (!name) return { label: ACCOUNT_IDENTITY_PLACEHOLDER, avatarName: undefined, isPlaceholder: true };
  const local = name.split("@")[0] || name;
  return { label: name, avatarName: local, isPlaceholder: false };
}

/** 第二行的服务器 host：从 /client WS 地址取 host（含非默认端口）；解析不出就原样显示。 */
export function serverHostLabel(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

/** 尾部按钮：默认齿轮；只有「新版本已下载」才换成强调色「更新」。 */
export type AccountFooterTail = "gear" | "install";

export type AccountUpdateItem = {
  label: string;
  /** 进行中（检查 / 下载）时不可点 */
  isDisabled: boolean;
  /** 点击做什么：重新检查，还是重启装新版 */
  action: "check" | "install";
  /** 副文案（失败原因等）；无则空串 */
  detail: string;
};

export type AccountFooterView = {
  tail: AccountFooterTail;
  updateItem: AccountUpdateItem;
  /** tail === "install" 时更新按钮的 tooltip；其余状态为空串 */
  installHint: string;
};

/** ` v0.1.6`／版本缺失时为空串——避免出现「重启并更新 v」这种半截文案。 */
function versionSuffix(version: string | undefined): string {
  return version ? ` v${version}` : "";
}

/**
 * 更新状态 → 脚部展示。语义固定：
 * 只有 `downloaded` 产生 `install` 尾部按钮，其余状态脚部静默（保持齿轮），细节只出现在菜单项文案里。
 * `downloaded` 在主进程是粘性终态（见 main/update-state.ts），所以这个按钮一旦出现就稳定。
 * 开发版点「检查更新」会立刻拿到 `error: 开发版不检查更新`，照映射显示即可。
 */
export function resolveAccountFooter(update: DesktopUpdateState, appVersion: string): AccountFooterView {
  const gear = (updateItem: AccountUpdateItem): AccountFooterView => ({ tail: "gear", updateItem, installHint: "" });
  switch (update.status) {
    case "idle":
      return gear({ label: "检查更新", isDisabled: false, action: "check", detail: "" });
    case "checking":
      return gear({ label: "正在检查更新…", isDisabled: true, action: "check", detail: "" });
    case "available":
      return gear({ label: `正在下载${versionSuffix(update.version)}…`, isDisabled: true, action: "check", detail: "" });
    case "downloading":
      return gear({
        label: `正在下载${versionSuffix(update.version)}（${update.percent ?? 0}%）…`,
        isDisabled: true,
        action: "check",
        detail: "",
      });
    case "downloaded":
      return {
        tail: "install",
        updateItem: { label: `重启并更新${versionSuffix(update.version)}`, isDisabled: false, action: "install", detail: "" },
        installHint: `${update.version ? `v${update.version} ` : "新版本"}已下载，点击重启并更新`,
      };
    case "not-available":
      return gear({ label: `已是最新版本${versionSuffix(appVersion)}`, isDisabled: false, action: "check", detail: "" });
    case "error":
      return gear({ label: "检查更新失败，重试", isDisabled: false, action: "check", detail: update.message ?? "未知错误" });
  }
}
