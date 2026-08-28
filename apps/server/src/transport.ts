/**
 * WebSocket 接入层：把"建连 → 解码信封 → 派发 → 心跳/超时/错误处理"的样板抽出来，
 * 让 index.ts 只负责装配、hub 只负责领域逻辑。
 *
 * wire：WS 上只有 binary message，每条 = 一个 protobuf 编码的信封；decode 失败（畸形字节/
 * 未知 oneof case）直接丢弃，不再需要单独的 JSON 文本帧 + isValid* 校验表。
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { WebSocketServer, WebSocket } from "ws";
import type { Logger } from "@coflux/core";

export interface EndpointOptions<Ctx, Msg> {
  /** 每条连接的上下文 */
  makeCtx: (ws: WebSocket, request: IncomingMessage) => Ctx;
  /** 该连接是否已认证（用于认证截止判定） */
  isAuthed: (ctx: Ctx) => boolean;
  /** 未认证但处于合法等待态（如 daemon 等浏览器授权），deadline 到点豁免不关。
   * 等待态自身要有界（授权 pending 有 TTL + 断线作废），否则等于给匿名连接开无限白嫖口。 */
  canWaitAuth?: (ctx: Ctx) => boolean;
  /** 信封解码：畸形/未知返回 null（丢弃） */
  decode: (buf: Buffer) => Msg | null;
  /** hub 的 handler 已 async 化（触库）；本层负责 await 并兜底捕获拒绝，不阻塞其它连接。 */
  onMessage: (ctx: Ctx, msg: Msg) => void | Promise<void>;
  /** close code/reason 用于区分心跳 terminate（通常 1006）与对端主动关闭。 */
  onClose: (ctx: Ctx, close: { code: number; reason: string }) => void | Promise<void>;
  authDeadlineMs: number;
  /** 已解码但尚未开始执行的单连接积压上限；当前正在执行的消息不计入 pending。 */
  maxPendingMessages: number;
  maxPendingBytes: number;
  logger: Logger;
}

export interface Endpoint {
  /** 心跳扫描：上一轮无 pong 的连接判死并 terminate（触发 close 清理） */
  sweep: () => void;
}

/** 生产通常由同机 Caddy 反代：仅当直连对端是 loopback 时信任它覆盖的 X-Forwarded-For；
 * 服务若直接暴露公网则只取 TCP peer，避免客户端自行伪造来源绕过限速。 */
export function requestAddress(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress ?? "unknown";
  const loopback = direct === "127.0.0.1" || direct === "::1" || direct.startsWith("::ffff:127.");
  if (!loopback) return direct;
  const header = request.headers["x-forwarded-for"];
  const first = (Array.isArray(header) ? header[0] : header)?.split(",", 1)[0]?.trim();
  return first && isIP(first) !== 0 ? first : direct;
}

export function attachEndpoint<Ctx, Msg>(wss: WebSocketServer, opts: EndpointOptions<Ctx, Msg>): Endpoint {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const ctx = opts.makeCtx(ws, request);
    // WebSocket 事件不会等待 async handler。显式队列既保证 wire 顺序，又给累计内存设硬边界；
    // close/过载后只让当前 handler 收尾，尚未开始的消息全部丢弃，避免已关闭连接继续触库。
    const pending: { msg: Msg; bytes: number }[] = [];
    let pendingBytes = 0;
    let draining = false;
    let accepting = true;
    let closed = false;
    let closeHandled = false;
    let closeInfo: { code: number; reason: string } | undefined;

    const discardPending = () => {
      pending.length = 0;
      pendingBytes = 0;
    };
    const reportError = (label: string, err: unknown) => {
      opts.logger.error(label, { err: err instanceof Error ? err.message : String(err) });
    };
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (!closed && pending.length > 0) {
          const item = pending.shift()!;
          pendingBytes -= item.bytes;
          try {
            await opts.onMessage(ctx, item.msg);
          } catch (err) {
            reportError("handler error", err);
          }
          // handler 可能已因认证失败/协议违规主动 close；不要等 close 事件下一轮才停止，
          // 否则同一 TCP 批次里早已排队的消息仍会在 CLOSING 窗口继续执行。
          if (ws.readyState !== ws.OPEN) {
            accepting = false;
            discardPending();
          }
        }
        if (closed && !closeHandled && closeInfo) {
          closeHandled = true;
          try {
            await opts.onClose(ctx, closeInfo);
          } catch (err) {
            reportError("close handler error", err);
          }
        }
      } finally {
        draining = false;
        if ((!closed && pending.length > 0) || (closed && !closeHandled && closeInfo)) void drain();
      }
    };
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const deadline = setTimeout(() => {
      if (!opts.isAuthed(ctx) && !opts.canWaitAuth?.(ctx)) ws.close(4008, "auth timeout");
    }, opts.authDeadlineMs);

    ws.on("message", (raw, isBinary) => {
      if (!isBinary || !accepting) return; // 全 binary 协议：文本帧一律忽略
      const frame = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      const msg = opts.decode(frame);
      if (msg === null) return;
      if (
        pending.length >= opts.maxPendingMessages ||
        frame.byteLength > opts.maxPendingBytes - pendingBytes
      ) {
        accepting = false;
        opts.logger.warn("WS 入站队列超过硬上限，断开连接", {
          pendingMessages: pending.length,
          pendingBytes,
          frameBytes: frame.byteLength,
          maxPendingMessages: opts.maxPendingMessages,
          maxPendingBytes: opts.maxPendingBytes,
        });
        discardPending();
        try {
          ws.close(1013, "inbound queue limit");
        } catch {
          ws.terminate();
        }
        return;
      }
      pending.push({ msg, bytes: frame.byteLength });
      pendingBytes += frame.byteLength;
      void drain();
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(deadline);
      accepting = false;
      closed = true;
      closeInfo = { code, reason: reason.toString("utf8").slice(0, 120) };
      discardPending();
      // 当前 handler 若正在完成 auth/register，drain 会在其后清理，避免关闭连接被重新登记在线。
      void drain();
    });
    ws.on("error", (err) => opts.logger.warn("ws error", { err: (err as Error).message }));
  });

  return {
    sweep() {
      for (const ws of wss.clients) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
