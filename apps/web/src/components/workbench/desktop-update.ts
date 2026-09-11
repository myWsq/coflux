import type { DesktopUpdateState } from "@/desktop-bridge";

/**
 * 版本准入被拒（clientOutdated）在桌面 app 里的展示（plan 103）：不是断线也不是登录失败，
 * 而是「需要更新」——把 electron-updater 的状态映射成一段文案 + 至多一个动作。纯函数，便于单测。
 */
export type OutdatedPrompt = {
  title: string;
  description: string;
  /** 进行中（检查/下载）时为 true：只显示进度，没有按钮 */
  busy: boolean;
  action: { label: string; kind: "check" | "install" } | null;
};

export function resolveOutdatedPrompt(update: DesktopUpdateState): OutdatedPrompt {
  const title = "需要更新";
  switch (update.status) {
    case "idle":
    case "checking":
      return { title, description: "服务器已部署新版本，正在检查桌面版更新…", busy: true, action: null };
    case "available":
      return { title, description: `发现 v${update.version ?? ""}，正在下载…`, busy: true, action: null };
    case "downloading":
      return { title, description: `正在下载 v${update.version ?? ""}（${update.percent ?? 0}%）…`, busy: true, action: null };
    case "downloaded":
      return { title, description: `v${update.version ?? ""} 已下载完成，重启即可使用。`, busy: false, action: { label: "重启并更新", kind: "install" } };
    case "not-available":
      return {
        title,
        description: "还没有与服务器匹配的桌面版；发布通常在几分钟内完成，请稍后重试。",
        busy: false,
        action: { label: "重新检查", kind: "check" },
      };
    case "error":
      return { title, description: `检查更新失败：${update.message ?? "未知错误"}`, busy: false, action: { label: "重试", kind: "check" } };
  }
}
