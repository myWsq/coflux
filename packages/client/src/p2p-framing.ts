/**
 * P2P DataChannel 分片流（plan 076）。与 `crates/worker/src/p2p.rs` 的 FrameAssembler 对偶，
 * 格式是线上契约（见 protocol 包 `P2P_CHUNK_BYTES` 注释）：每个 DeviceEnvelope 帧封为
 * [u32 BE 帧长][帧字节]，按 ≤ 16KiB 切成 DataChannel messages；SCTP reliable+ordered 下
 * 等价字节流，接收端按前缀重组。
 */
import { MAX_DEVICE_FRAME_BYTES, P2P_CHUNK_BYTES } from "@coflux/protocol";

/** 把一个完整帧编成待发送的 DataChannel message 序列（长度前缀 + 分片）。 */
export function p2pFrameChunks(frame: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const stream = new Uint8Array(4 + frame.byteLength);
  new DataView(stream.buffer).setUint32(0, frame.byteLength);
  stream.set(frame, 4);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < stream.byteLength; offset += P2P_CHUNK_BYTES) {
    chunks.push(stream.subarray(offset, Math.min(offset + P2P_CHUNK_BYTES, stream.byteLength)));
  }
  return chunks;
}

/**
 * 长度前缀分片流重组器。跨 message 累积（chunk 列表 + 帧完整时一次合并，避免逐 push
 * 拼接的 O(n²) 拷贝）；帧长为 0 或超 MAX_DEVICE_FRAME_BYTES 即协议违规，抛错后字节流
 * 已失步，调用方必须关闭 channel。
 */
export class P2pFrameAssembler {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private need?: number;

  push(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
    if (bytes.byteLength > 0) {
      this.chunks.push(bytes);
      this.total += bytes.byteLength;
    }
    const frames: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      if (this.need === undefined) {
        if (this.total < 4) return frames;
        const head = this.take(4);
        const declared = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
        if (declared === 0 || declared > MAX_DEVICE_FRAME_BYTES) {
          throw new Error(`P2P 帧长前缀违规: ${declared}`);
        }
        this.need = declared;
      }
      if (this.total < this.need) return frames;
      frames.push(this.take(this.need));
      this.need = undefined;
    }
  }

  private take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.chunks[0]!;
      const want = count - offset;
      if (head.byteLength <= want) {
        out.set(head, offset);
        offset += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), offset);
        this.chunks[0] = head.subarray(want);
        offset += want;
      }
    }
    this.total -= count;
    return out;
  }
}
