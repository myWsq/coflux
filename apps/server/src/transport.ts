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
  /** 入站消息运行时校验（畸形/未知直接丢弃） */
  validate: (msg: unknown) => boolean;
  onMessage: (ctx: Ctx, msg: unknown) => void;
  onClose: (ctx: Ctx) => void;
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
      if (!opts.isAuthed(ctx)) ws.close(4008, "auth timeout");
    }, opts.authDeadlineMs);

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = decode<unknown>(raw as Buffer);
      } catch {
        return;
      }
      if (!opts.validate(msg)) return;
      try {
        opts.onMessage(ctx, msg);
      } catch (err) {
        opts.logger.error("handler error", { err: (err as Error).message });
      }
    });

    ws.on("close", () => {
      clearTimeout(deadline);
      opts.onClose(ctx);
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
