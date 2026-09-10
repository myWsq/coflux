import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import { IPC, type Bootstrap } from "../shared/ipc";
import { isTrustedRendererUrl } from "./ipc-trust";

export type TrustedSenders = { appOrigin: string; devRendererUrl?: string };

export type IpcActions = {
  bootstrap: () => Bootstrap;
};

/** 每条 IPC 都先校验发送方 frame 来源；不可信一律忽略（handle 则抛错）。 */
export function registerIpc(actions: IpcActions, trusted: TrustedSenders): void {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);

  ipcMain.on(IPC.bootstrap, (event) => {
    if (!isTrusted(event)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = actions.bootstrap();
  });
}
