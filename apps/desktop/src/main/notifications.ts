import { app, Notification } from "electron";

import type { DesktopNotification } from "../../../web/src/desktop-bridge";

/**
 * 系统通知 + Dock 角标（plan 103）：主进程只执行，状态判定在渲染层（desktop-attention.ts）。
 * Electron 42+ 在 macOS 用 UNUserNotification：未签名构建上直接失败，这里不做「退回 HTML5
 * Notification」的分叉——通知/角标只在签名产物上验收。
 */
export function showWorkspaceNotification(notification: DesktopNotification, onClick: (workspaceId: string) => void): void {
  if (!Notification.isSupported()) return;
  const native = new Notification({ title: notification.title, body: notification.body });
  native.on("click", () => onClick(notification.workspaceId));
  native.show();
}

/** 待处理工作区数；0 清空。非 macOS 没有 dock，安静忽略。 */
export function setDockBadge(count: number): void {
  app.dock?.setBadge(count > 0 ? String(count) : "");
}
