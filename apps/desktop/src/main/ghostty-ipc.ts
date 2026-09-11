import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { GHOSTTY_BATCH, GHOSTTY_CHUNK, type GhosttyCreate, type GhosttyEvent, type GhosttyMessage, type GhosttyNative, type GhosttyOperation, type GhosttyReady, type GhosttyRect, type GhosttyState, type SurfaceKey } from "../shared/ghostty";
import { IPC } from "../shared/ipc";
import { GhosttyGenerations, GhosttyQueue } from "./ghostty-queue";
import { isTrustedRendererUrl } from "./ipc-trust";

const requireNative = createRequire(import.meta.url);
let native: GhosttyNative | undefined;
let allocatedBytes: () => number | null = () => null;
export function ghosttyAllocatedBytes(): number | null { return allocatedBytes(); }
let clipboardHandler: (paste: boolean) => boolean = () => false;
export function routeGhosttyClipboard(paste: boolean): boolean { return clipboardHandler(paste); }
function loadNative(): GhosttyNative {
  // 变量路径 + createRequire：bundler 从不读取 .node。关闭开关时连这个函数也不调用。
  const path = app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked/native/ghostty/build/coflux_ghostty.node")
    : fileURLToPath(new URL("../../native/ghostty/build/coflux_ghostty.node", import.meta.url));
  return native ??= requireNative(path) as GhosttyNative;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function key(value: unknown): value is SurfaceKey & Record<string, unknown> {
  return object(value) && typeof value.surfaceId === "string" && value.surfaceId.length > 0 && value.surfaceId.length <= 160
    && Number.isSafeInteger(value.generation) && Number(value.generation) > 0;
}
function isGhosttyCreate(value: unknown): value is GhosttyCreate {
  return key(value) && rect(value.rect);
}
function rect(value: unknown): value is GhosttyRect {
  if (!object(value)) return false;
  return ["x", "y", "width", "height", "dpr"].every((name) => typeof value[name] === "number" && Number.isFinite(value[name]))
    && Number(value.width) > 0 && Number(value.height) > 0 && Number(value.width) <= 32768 && Number(value.height) <= 32768
    && Math.abs(Number(value.x)) <= 65536 && Math.abs(Number(value.y)) <= 65536 && Number(value.dpr) > 0 && Number(value.dpr) <= 16;
}
function state(value: unknown): value is GhosttyState {
  return object(value) && ["active", "owned", "occluded", "focus"].every((name) => typeof value[name] === "boolean")
    && Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0;
}
export function isGhosttyBatch(value: unknown): value is GhosttyMessage[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  let total = 0;
  return value.every((message: unknown) => {
    if (!key(message) || !object(message) || !Number.isSafeInteger(message.sequence) || Number(message.sequence) < 1 || !object(message.operation)) return false;
    const op = message.operation;
    switch (op.kind) {
      case "output":
        if (!(op.bytes instanceof Uint8Array) || op.bytes.byteLength > GHOSTTY_CHUNK || typeof op.replace !== "boolean" || typeof op.replay !== "boolean") return false;
        total += op.bytes.byteLength;
        return total <= GHOSTTY_BATCH && (!op.replace || op.replay);
      case "frame": return rect(op.rect);
      case "state": return state(op.state);
      case "recover": return typeof op.reason === "string" && op.reason.length <= 256;
      case "dump": return typeof op.requestId === "string" && op.requestId.length <= 128;
      default: return false;
    }
  });
}

type Entry = {
  key: SurfaceKey; id: number; queue: GhosttyQueue; state: GhosttyState; applied?: GhosttyState;
  wait?: { kind: number; done: () => void }; timer?: ReturnType<typeof setTimeout>;
  rejectReady: (error: Error) => void;
};

export function registerGhosttyIpc(enabled: boolean, trusted: { appOrigin: string; devRendererUrl?: string }): void {
  const owners = new Map<number, { entries: Map<string, Entry>; generations: GhosttyGenerations }>();
  allocatedBytes = () => {
    if (!enabled || !native) return null;
    const values = [...owners.values()].flatMap((owner) => [...owner.entries.values()].map((entry) => native!.allocatedBytes(entry.id))).filter((value) => value >= 0);
    return values.length ? Math.max(...values) : null;
  };
  clipboardHandler = (paste) => {
    if (!enabled || !native) return false;
    for (const owner of owners.values()) for (const entry of owner.entries.values()) {
      if (native.hasFocus(entry.id)) { if (paste) native.paste(entry.id); else native.copy(entry.id); return true; }
    }
    return false;
  };
  const trustedWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow => {
    if (!enabled || !isTrustedRendererUrl(event.senderFrame?.url, trusted) || event.senderFrame !== event.sender.mainFrame) throw new Error("Ghostty IPC 来源不可信或开关未启用");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) throw new Error("Ghostty 窗口不存在");
    return window;
  };
  const drop = (entries: Map<string, Entry>, entry: Entry) => {
    if (entries.get(entry.key.surfaceId) !== entry) return;
    entries.delete(entry.key.surfaceId);
    entry.queue.destroy();
    clearTimeout(entry.timer);
    entry.wait = undefined;
    entry.rejectReady(new Error("Ghostty surface 已销毁"));
    native?.destroy(entry.id);
  };
  ipcMain.handle(IPC.ghosttyCreate, async (event, request: unknown): Promise<GhosttyReady> => {
    const window = trustedWindow(event);
    if (!isGhosttyCreate(request)) throw new Error("无效 Ghostty create");
    const input = request;
    const ownerId = event.sender.id;
    let owner = owners.get(ownerId);
    if (!owner) {
      owner = { entries: new Map(), generations: new GhosttyGenerations() };
      owners.set(ownerId, owner);
      const dispose = () => {
        const current = owners.get(ownerId);
        if (!current) return;
        for (const entry of [...current.entries.values()]) drop(current.entries, entry);
        owners.delete(ownerId);
      };
      event.sender.once("destroyed", dispose);
      event.sender.on("render-process-gone", dispose);
      event.sender.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) dispose(); });
      window.on("hide", () => { for (const entry of owners.get(ownerId)?.entries.values() ?? []) { native?.setAccess(entry.id, false, entry.state.epoch); native?.setFocus(entry.id, false); native?.setVisible(entry.id, false); } });
      window.on("show", () => { for (const entry of owners.get(ownerId)?.entries.values() ?? []) applyState(entry); });
    }
    if (owner.entries.size >= 64 && !owner.entries.has(input.surfaceId)) throw new Error("Ghostty surface 数量超过上限");
    if (!owner.generations.advance(input)) throw new Error("过期 Ghostty generation");
    const previous = owner.entries.get(input.surfaceId);
    if (previous) drop(owner.entries, previous);
    const addon = loadNative();
    const entries = owner.entries;
    const surfaceKey: SurfaceKey = { surfaceId: input.surfaceId, generation: input.generation };
    const send = (message: GhosttyEvent) => {
      if (event.sender.isDestroyed() || entries.get(surfaceKey.surfaceId)?.key.generation !== surfaceKey.generation) return;
      event.sender.send(IPC.ghosttyEvent, message);
    };
    const points = (r: GhosttyRect) => {
      const zoom = window.webContents.getZoomFactor();
      return [r.x * zoom, r.y * zoom, r.width * zoom, r.height * zoom, r.dpr / zoom] as const;
    };
    function applyState(entry: Entry) {
      const applied = entry.applied;
      if (!applied || applied.epoch !== entry.state.epoch) return;
      const visible = applied.active && !applied.occluded && window.isVisible();
      addon.setAccess(entry.id, visible && applied.owned, applied.epoch);
      addon.setVisible(entry.id, visible);
      addon.setFocus(entry.id, visible && entry.state.focus);
    }
    return new Promise<GhosttyReady>((resolve, reject) => {
      let entry: Entry;
      let ready = false;
      const awaitNative = (kind: number, done: () => void) => {
        clearTimeout(entry.timer);
        entry.wait = { kind, done };
        entry.timer = setTimeout(() => {
          entry.wait = undefined;
          entry.queue.recover("Ghostty 原生操作未在 15 秒内完成");
        }, 15_000);
      };
      const execute = (operation: GhosttyOperation, complete: (error?: string) => void) => {
        switch (operation.kind) {
          case "state":
            if (operation.state.epoch >= entry.state.epoch) {
              entry.state = operation.state; entry.applied = operation.state; applyState(entry);
            }
            complete(); return;
          case "frame":
            awaitNative(8, () => complete());
            addon.setFrame(entry.id, ...points(operation.rect)); return;
          case "output": {
            const write = () => {
              awaitNative(6, () => complete());
              const accepted = (operation.replay ? addon.replay : addon.write)(entry.id, Buffer.from(operation.bytes));
              if (!accepted) { clearTimeout(entry.timer); entry.wait = undefined; complete("原生层拒绝输出，需要完整恢复"); }
            };
            if (operation.replace) { awaitNative(9, write); addon.reset(entry.id); }
            else write();
            return;
          }
          case "dump": send({ ...surfaceKey, kind: "dump", requestId: operation.requestId, text: addon.dump(entry.id) }); complete(); return;
          case "recover": complete(operation.reason); return;
        }
      };
      const queue = new GhosttyQueue(surfaceKey, execute, (message) => {
        if (message.kind === "resume") { addon.setAccess(entry.id, false, entry.state.epoch); addon.setFocus(entry.id, false); }
        send(message);
      });
      const id = addon.create(window.getNativeWindowHandle(), ...points(input.rect), (nativeId, kind, bytes, x, y) => {
        if (!entry || entries.get(surfaceKey.surfaceId) !== entry || entry.id !== nativeId) return;
        if (kind === 1 && !ready) {
          ready = true;
          clearTimeout(entry.timer);
          resolve({ cols: Math.max(1, x), rows: Math.max(1, y) });
        } else if (kind === 5) {
          const reason = new TextDecoder().decode(bytes);
          reject(new Error(reason)); queue.recover(reason);
        } else if (entry.wait?.kind === kind) {
          const done = entry.wait.done;
          entry.wait = undefined; clearTimeout(entry.timer); done();
        } else if (!queue.recovering) {
          if (kind === 2 && entry.state.active && entry.state.owned && !entry.state.occluded && window.isVisible() && x === entry.state.epoch)
            send({ ...surfaceKey, kind: "input", bytes, epoch: x });
          if (kind === 3 && x > 0 && y > 0) send({ ...surfaceKey, kind: "resize", cols: x, rows: y, epoch: entry.state.epoch });
          if (kind === 4) send({ ...surfaceKey, kind: "url", url: new TextDecoder().decode(bytes) });
          if (kind === 7) send({ ...surfaceKey, kind: "command", command: new TextDecoder().decode(bytes) });
          if (kind === 10) send({ ...surfaceKey, kind: "notice", message: new TextDecoder().decode(bytes) });
        }
      });
      entry = { key: surfaceKey, id, queue, state: { active: false, owned: false, occluded: true, focus: false, epoch: 0 }, rejectReady: reject };
      entries.set(surfaceKey.surfaceId, entry);
      addon.setVisible(id, false);
      addon.setAccess(id, false, 0);
      entry.timer = setTimeout(() => { reject(new Error("Ghostty create-ready 超时")); drop(entries, entry); }, 15_000);
    });
  });
  ipcMain.handle(IPC.ghosttyDestroy, (event, input: unknown) => {
    trustedWindow(event);
    if (!key(input)) return;
    const entries = owners.get(event.sender.id)?.entries;
    const entry = entries?.get(input.surfaceId);
    if (entries && entry?.queue.accepts(input)) drop(entries, entry);
  });
  ipcMain.on(IPC.ghosttySend, (event, input: unknown) => {
    try { trustedWindow(event); } catch { return; }
    if (!isGhosttyBatch(input)) return;
    const entries = owners.get(event.sender.id)?.entries;
    for (const message of input) {
      const entry = entries?.get(message.surfaceId);
      if (!entry?.queue.accepts(message)) continue;
      // 撤销门禁立即生效，不能等一个慢解析块；恢复允许仍走有序队列。
      const op = message.operation;
      if (op.kind === "state" && !entry.queue.recovering && message.sequence === entry.queue.nextSequence && op.state.epoch >= entry.state.epoch) {
        entry.state = op.state;
        if (!op.state.active || !op.state.owned || op.state.occluded) native?.setAccess(entry.id, false, op.state.epoch);
        if (!op.state.active || op.state.occluded) { native?.setFocus(entry.id, false); native?.setVisible(entry.id, false); }
      }
      entry.queue.receive(message);
    }
  });
}
