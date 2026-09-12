import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../shared/ipc";
import type { NativeOpen } from "../shared/native-transport";
import type { NativeTailcatTransport } from "./tailcat-transport";
import { isTrustedRendererUrl } from "./ipc-trust";
import type { TrustedSenders } from "./ipc";

export function registerTailcatIpc(transport: NativeTailcatTransport, trusted: TrustedSenders): void {
  const allowed = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
  ipcMain.handle(IPC.tailcatOpen, (event, raw: unknown) => {
    if (!allowed(event) || !raw || typeof raw !== "object") throw new Error("远程连接请求无效");
    const value = raw as NativeOpen;
    if (!id(value.requestId) || !id(value.daemonId) || !id(value.clientInstanceId) || typeof value.generation !== "string" || !/^\d{1,20}$/.test(value.generation) || BigInt(value.generation) > 18446744073709551615n || !Number.isInteger(value.scope)) throw new Error("远程连接参数无效");
    return transport.open(value);
  });
  ipcMain.handle(IPC.tailcatSend, (event, handle: unknown, frame: unknown) => allowed(event) && id(handle) && frame instanceof Uint8Array && frame.byteLength <= 30 * 1024 * 1024 && transport.send(handle, frame));
  ipcMain.on(IPC.tailcatAck, (event, handle: unknown, bytes: unknown) => { if (allowed(event) && id(handle) && typeof bytes === "number") transport.acknowledge(handle, bytes); });
  ipcMain.on(IPC.tailcatClose, (event, handle: unknown) => { if (allowed(event) && id(handle)) transport.closeLane(handle); });
  ipcMain.on(IPC.tailcatControl, (event, online: unknown, hard: unknown) => { if (allowed(event) && typeof online === "boolean" && typeof hard === "boolean") transport.setControl(online, hard); });
}
