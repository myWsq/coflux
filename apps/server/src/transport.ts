/**
 * WebSocket 接入层：把"建连 → 解码 → 校验 → 派发 → 心跳/超时/错误处理"的样板抽出来，
 * 让 index.ts 只负责装配、hub 只负责领域逻辑。
 */
import type { WebSocketServer, WebSocket } from "ws";
import type { Logger } from "@coflux/core";
import { decode } from "@coflux/protocol";

export interface EndpointOptions<Ctx> {
  /** 每条连接的上下文 */
  makeCtx: (ws: WebSocket) => Ctx;
  /** 该连接是否已认证（用于认证截止判定） */
  isAuthed: (ctx: Ctx) => boolean;
  /** 未认证但处于合法等待态（如 daemon 等浏览器授权），deadline 到点豁免不关。
   * 等待态自身要有界（授权 pending 有 TTL + 断线作废），否则等于给匿名连接开无限白嫖口。 */
  canWaitAuth?: (ctx: Ctx) => boolean;
  /** 入站消息运行时校验（畸形/未知直接丢弃） */
  validate: (msg: unknown) => boolean;
  /** hub 的 handler 已 async 化（触库）；本层负责 await 并兜底捕获拒绝，不阻塞其它连接。 */
  onMessage: (ctx: Ctx, msg: unknown) => void | Promise<void>;
  /** 入站二进制数据面帧（仅认证后处理；归属校验在 handler 内做） */
  onBinary?: (ctx: Ctx, buf: Buffer) => void | Promise<void>;
  onClose: (ctx: Ctx) => void | Promise<void>;
  authDeadlineMs: number;
  logger: Logger;
}

export interface Endpoint {
  /** 心跳扫描：上一轮无 pong 的连接判死并 terminate（触发 close 清理） */
  sweep: () => void;
}

export function attachEndpoint<Ctx>(wss: WebSocketServer, opts: EndpointOptions<Ctx>): Endpoint {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    const ctx = opts.makeCtx(ws);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const deadline = setTimeout(() => {
      if (!opts.isAuthed(ctx) && !opts.canWaitAuth?.(ctx)) ws.close(4008, "auth timeout");
    }, opts.authDeadlineMs);

    ws.on("message", (raw, isBinary) => {
      // 数据面：二进制帧，仅认证后处理，归属校验在 handler 内做
      if (isBinary) {
        if (!opts.onBinary || !opts.isAuthed(ctx)) return;
        try {
          const r = opts.onBinary(ctx, raw as Buffer);
          if (r instanceof Promise) r.catch((err) => opts.logger.error("binary handler error", { err: (err as Error).message }));
        } catch (err) {
          opts.logger.error("binary handler error", { err: (err as Error).message });
        }
        return;
      }
      // 控制面：JSON 文本帧
      let msg: unknown;
      try {
        msg = decode<unknown>(raw as Buffer);
      } catch {
        return;
      }
      if (!opts.validate(msg)) return;
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
