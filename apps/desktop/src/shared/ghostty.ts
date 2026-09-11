/** Ghostty spike 的窄桥接契约；所有输出和控制消息共用有序 send 通道。 */
export const GHOSTTY_QUOTA = 8 * 1024 * 1024;
export const GHOSTTY_CHUNK = 64 * 1024;
export const GHOSTTY_BATCH = 256 * 1024;
export const GHOSTTY_MAX_OPERATIONS = 512;
export type SurfaceKey = { surfaceId: string; generation: number };
export type GhosttyRect = { x: number; y: number; width: number; height: number; dpr: number };
export type GhosttyState = { active: boolean; owned: boolean; occluded: boolean; focus: boolean; epoch: number };
export type GhosttyOperation =
  | { kind: "output"; bytes: Uint8Array; replace: boolean; replay: boolean }
  | { kind: "frame"; rect: GhosttyRect }
  | { kind: "state"; state: GhosttyState }
  | { kind: "recover"; reason: string }
  | { kind: "dump"; requestId: string };
export type GhosttyMessage = SurfaceKey & { sequence: number; operation: GhosttyOperation };
export type GhosttyEvent = SurfaceKey & (
  | { kind: "ack"; sequence: number; bytes: number; queuedBytes: number; peakBytes: number }
  | { kind: "resume"; reason: string }
  | { kind: "input"; bytes: Uint8Array; epoch: number }
  | { kind: "resize"; cols: number; rows: number; epoch: number }
  | { kind: "url"; url: string }
  | { kind: "command"; command: string }
  | { kind: "notice"; message: string }
  | { kind: "dump"; requestId: string; text: string }
);
export type GhosttyCreate = SurfaceKey & { rect: GhosttyRect };
export type GhosttyReady = { cols: number; rows: number };
export type GhosttyBridge = {
  readonly enabled: boolean;
  create(request: GhosttyCreate): Promise<GhosttyReady>;
  destroy(key: SurfaceKey): Promise<void>;
  send(messages: readonly GhosttyMessage[]): void;
  onEvent(listener: (event: GhosttyEvent) => void): () => void;
};

/** addon 回调始终主线程；1 ready / 6 parsed / 8 resized / 9 reset 完成。 */
export type GhosttyNativeCallback = (id: number, kind: number, bytes: Uint8Array, x: number, y: number) => void;
export type GhosttyNative = {
  create(handle: Uint8Array, x: number, y: number, width: number, height: number, scale: number, callback: GhosttyNativeCallback): number;
  destroy(id: number): void;
  setFrame(id: number, x: number, y: number, width: number, height: number, scale: number): void;
  setVisible(id: number, visible: boolean): void;
  setFocus(id: number, focused: boolean): void;
  setAccess(id: number, allowed: boolean, epoch: number): void;
  write(id: number, bytes: Uint8Array): boolean;
  replay(id: number, bytes: Uint8Array): boolean;
  reset(id: number): void;
  dump(id: number): string;
  grid(id: number): { columns: number; rows: number };
  pump(): void;
  copy(id: number): void;
  paste(id: number): void;
  hasFocus(id: number): boolean;
  allocatedBytes(id: number): number;
};
