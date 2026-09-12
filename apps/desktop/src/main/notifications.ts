import { app, Notification } from "electron";

import type { DesktopNotification } from "../shared/desktop-bridge";

/**
 * Native notifications and Dock badges. The renderer derives attention events and counts;
 * the main-process caller checks actual window focus and visibility before showing explicit
 * inbox notifications. Electron 42+ uses UNUserNotification on macOS, which requires a signed
 * build. Verify native delivery with a signed package; there is no HTML5 Notification fallback.
 */
export function showWorkspaceNotification(notification: DesktopNotification, onClick: (notification: DesktopNotification) => void): void {
  if (!Notification.isSupported()) return;
  const native = new Notification({ title: notification.title, body: notification.body });
  native.on("click", () => onClick(notification));
  native.show();
}

/** Combined waiting-workspace and unread-inbox count; zero clears the badge. No-op without a Dock. */
export function setDockBadge(count: number): void {
  app.dock?.setBadge(count > 0 ? String(count) : "");
}
