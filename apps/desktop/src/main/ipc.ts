import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import type { DesktopNotification, DesktopUpdateState } from "../shared/desktop-bridge";
import { IPC, type Bootstrap } from "../shared/ipc";
import { sanitizeBadgeCount, sanitizeNotification } from "./ipc-sanitize";
import { isTrustedRendererUrl } from "./ipc-trust";

export type TrustedSenders = { appOrigin: string; devRendererUrl?: string };

export type IpcActions = {
  bootstrap: () => Bootstrap;
  notify: (notification: DesktopNotification) => void;
  setBadge: (count: number) => void;
  checkForUpdates: () => void;
  installUpdate: () => void;
  getUpdateState: () => DesktopUpdateState;
};

/** 每条 IPC 都先校验发送方 frame 来源；不可信一律忽略。 */
export function registerIpc(actions: IpcActions, trusted: TrustedSenders): void {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);

  ipcMain.on(IPC.bootstrap, (event) => {
    if (!isTrusted(event)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = actions.bootstrap();
  });

  ipcMain.on(IPC.notify, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const notification = sanitizeNotification(payload);
    if (notification) actions.notify(notification);
  });

  ipcMain.on(IPC.setBadge, (event, payload: unknown) => {
    if (!isTrusted(event)) return;
    const count = sanitizeBadgeCount(payload);
    if (count !== null) actions.setBadge(count);
  });

  ipcMain.on(IPC.checkForUpdates, (event) => {
    if (isTrusted(event)) actions.checkForUpdates();
  });

  ipcMain.on(IPC.installUpdate, (event) => {
    if (isTrusted(event)) actions.installUpdate();
  });

  ipcMain.handle(IPC.getUpdateState, (event) => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    return actions.getUpdateState();
  });
}
