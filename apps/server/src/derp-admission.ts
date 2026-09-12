import { createServer, type Server } from "node:http";

/** Stock derper's verifier runs on a separate loopback-only listener. Remote
 * relay hosts reach it through an authenticated private tunnel; the public
 * application listener never exposes registry mutation or verification routes. */
export function startDerpAdmission(admitted: (node: string) => boolean, port: number): Server {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid DERP admission port");
  const server = createServer({ requestTimeout: 2000, headersTimeout: 2000, maxHeaderSize: 4096 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const reject = () => { if (!response.writableEnded) { response.writeHead(403, { "Content-Type": "application/json" }); response.end('{"Allow":false}'); } };
    if (request.method !== "POST" || request.url !== "/verify") { reject(); request.resume(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) { reject(); request.destroy(); return; } chunks.push(chunk); });
    request.on("end", () => {
      if (response.writableEnded) return;
      let allowed = false;
      try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); allowed = typeof body.NodePublic === "string" && admitted(body.NodePublic); } catch { /* Reject malformed verifier requests. */ }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ Allow: allowed }));
    });
    request.on("error", reject);
  });
  server.maxConnections = 64;
  server.listen(port, "127.0.0.1");
  return server;
}
