export type NativeOpen = { requestId: string; daemonId: string; clientInstanceId: string; generation: string; scope: number };
export type NativeEvent = { handle: string; kind: "frame"; frame: Uint8Array } | { handle: string; kind: "closed" } | { handle: string; kind: "path"; mode: "direct" | "relay" | "unknown"; rttMs?: number };
export type NativeTransportBridge = {
  open(request: NativeOpen): Promise<{ handle: string; channelId: string; scopes: number[] }>;
  send(handle: string, frame: Uint8Array): boolean;
  close(handle: string): void;
  control(online: boolean, hard: boolean): void;
  onEvent(listener: (event: NativeEvent) => void): () => void;
};
