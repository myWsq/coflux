import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** 同一系统用户的 CLI 复用应用登录态。只代理账号操作，不向 CLI 返回会话 token。 */
export function startClientBroker(home: string, serverUrl: string, token: () => string) {
  const path = join(home, "client.sock");
  // 应用单实例锁已由主入口持有；更新后可清理退出遗留的旧 socket。
  rmSync(path, { force: true });
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.pathname = "/api/client/command";
  url.search = "";
  url.hash = "";
  const server = createServer((socket) => {
    let text = "";
    let sent = false;
    let handling = false;
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    const reply = (body: unknown) => {
      if (sent || socket.destroyed) return;
      sent = true;
      socket.end(`${JSON.stringify(body)}\n`);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (handling) return;
      text += chunk;
      if (Buffer.byteLength(text) > 128 * 1024) { socket.destroy(); return; }
      if (!text.includes("\n")) return;
      handling = true;
      void (async () => {
        try {
          const body = JSON.parse(text.slice(0, text.indexOf("\n")));
          if (body.protocolVersion !== 1 || typeof body.command?.op !== "string" || body.command.op === "logout") {
            reply({ ok: false, error: "此操作请在 Coflux 应用中完成" }); return;
          }
          const credential = token();
          if (!credential) { reply({ ok: false, error: "请先登录 Coflux 应用" }); return; }
          socket.setTimeout(610000, () => socket.destroy());
          const result = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(605000)]) });
          reply(await result.json());
        } catch { reply({ ok: false, error: "账号操作未能完成，请检查连接并查询操作结果" }); }
      })();
    });
  });
  server.on("error", () => undefined);
  server.listen(path, () => chmodSync(path, 0o600));
  server.unref();
  return () => { server.close(); rmSync(path, { force: true }); };
}
