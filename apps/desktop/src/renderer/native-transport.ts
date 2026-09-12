import type { NativeRemoteTransport } from "@coflux/client";
import type { DeviceScope } from "@coflux/protocol";
import type { NativeTransportBridge, NativeEvent } from "../shared/native-transport";

export function createNativeRemoteTransport(bridge: NativeTransportBridge): NativeRemoteTransport {
  const listeners = new Map<string, (event: NativeEvent) => void>();
  const unsubscribe = bridge.onEvent((event) => listeners.get(event.handle)?.(event));
  return {
    async open(options) {
      const requestId = crypto.randomUUID(); let closed = false, opening = true, earlyBytes = 0, earlyRecords = 0;
      const close = () => { if (closed) return; closed = true; listeners.delete(requestId); options.signal.removeEventListener("abort", close); bridge.close(requestId); };
      if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
      options.signal.addEventListener("abort", close, { once: true });
      listeners.set(requestId, (event) => {
        if (event.kind === "closed") { close(); options.onClose("远程连接已中断"); }
        if (event.kind === "path") options.onPath?.(event.mode, event.rttMs);
        if (event.kind === "frame") {
          if (opening && ((earlyBytes += event.frame.byteLength) > 32 * 1024 * 1024 || ++earlyRecords > 256)) { close(); options.onClose("远程连接缓冲已满"); return; }
          options.onFrame(event.frame);
        }
      });
      try {
        const result = await bridge.open({ requestId, daemonId: options.daemonId, clientInstanceId: options.clientInstanceId, generation: options.generation.toString(), scope: options.scope });
        opening = false;
        if (closed || options.signal.aborted) { bridge.close(requestId); throw new DOMException("Aborted", "AbortError"); }
        return { nativeRemote: true, channelId: result.channelId, scopes: new Set(result.scopes as DeviceScope[]), send: (bytes) => !closed && bridge.send(requestId, bytes), close };
      } catch (error) { close(); throw error; }
    },
    control: (online, hard) => bridge.control(online, hard),
    close() { bridge.control(false, true); unsubscribe(); listeners.clear(); },
  };
}
