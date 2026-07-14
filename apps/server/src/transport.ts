/**
 * WebSocket 接入层：把"建连 → 解码信封 → 派发 → 心跳/超时/错误处理"的样板抽出来，
 * 让 index.ts 只负责装配、hub 只负责领域逻辑。
 *
 * wire：WS 上只有 binary message，每条 = 一个 protobuf 编码的信封；decode 失败（畸形字节/
 * 未知 oneof case）直接丢弃，不再需要单独的 JSON 文本帧 + isValid* 校验表。
 */
import type { WebSocketServer, WebSocket } from "ws";
import type { Logger } from "@coflux/core";

export interface EndpointOptions<Ctx, Msg> {
  /** 每条连接的上下文 */
  makeCtx: (ws: WebSocket) => Ctx;
  /** 该连接是否已认证（用于认证截止判定） */
  isAuthed: (ctx: Ctx) => boolean;
  /** 未认证但处于合法等待态（如 daemon 等浏览器授权），deadline 到点豁免不关。
   * 等待态自身要有界（授权 pending 有 TTL + 断线作废），否则等于给匿名连接开无限白嫖口。 */
  canWaitAuth?: (ctx: Ctx) => boolean;
  /** 信封解码：畸形/未知返回 null（丢弃） */
  decode: (buf: Buffer) => Msg | null;
  /** hub 的 handler 已 async 化（触库）；本层负责 await 并兜底捕获拒绝，不阻塞其它连接。 */
  onMessage: (ctx: Ctx, msg: Msg) => void | Promise<void>;
  onClose: (ctx: Ctx) => void | Promise<void>;
  authDeadlineMs: number;
  logger: Logger;
}

export interface Endpoint {
  /** 心跳扫描：上一轮无 pong 的连接判死并 terminate（触发 close 清理） */
  sweep: () => void;
}

export function attachEndpoint<Ctx, Msg>(wss: WebSocketServer, opts: EndpointOptions<Ctx, Msg>): Endpoint {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    const ctx = opts.makeCtx(ws);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const deadline = setTimeout(() => {
      if (!opts.isAuthed(ctx) && !opts.canWaitAuth?.(ctx)) ws.close(4008, "auth timeout");
    }, opts.authDeadlineMs);

    ws.on("message", (raw, isBinary) => {
      if (!isBinary) return; // 全 binary 协议：文本帧一律忽略
      const msg = opts.decode(raw as Buffer);
      if (msg === null) return;
      try {
        const r = opts.onMessage(ctx, msg);
        if (r instanceof Promise) r.catch((err) => opts.logger.error("handler error", { err: (err as Error).message }));
      } catch (err) {
        opts.logger.error("handler error", { err: (err as Error).message });
      }
    });

    ws.on("close", () => {
      clearTimeout(deadline);
      try {
        const r = opts.onClose(ctx);
        if (r instanceof Promise) r.catch((err) => opts.logger.error("close handler error", { err: (err as Error).message }));
      } catch (err) {
        opts.logger.error("close handler error", { err: (err as Error).message });
      }
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
