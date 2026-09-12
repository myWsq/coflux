// Independent stock DERP fixture. Certificates, keys, ports, and processes are temporary.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

export async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function spawnDerp(options = {}) {
  const directory = mkdtempSync(join(options.directory ?? tmpdir(), "coflux-derp-"));
  let child;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "127.0.0.1.key"), "-out", join(directory, "127.0.0.1.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const pin = createHash("sha256").update(new X509Certificate(readFileSync(join(directory, "127.0.0.1.crt"))).raw).digest("hex");
    const port = options.port ?? await reservePort();
    const args = ["-a", `127.0.0.1:${port}`, "-http-port", "-1", "-stun=false", "-hostname", "127.0.0.1", "-certmode", "manual", "-certdir", directory, "-c", join(directory, "derper.json")];
    if (options.verifyUrl) args.push("-verify-client-url", options.verifyUrl, "-verify-client-url-fail-open=false");
    child = spawn(process.env.COFLUX_TEST_DERPER_BIN || resolve(import.meta.dirname, "../../target/debug/coflux-test-derper"), args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    child.cofluxProcessGroupId = child.pid;
    options.onSpawn?.(child);
    let output = "", failure;
    child.stderr.on("data", bytes => { output = (output + bytes).slice(-8192); });
    child.once("error", error => { failure = error; });
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new Error("DERP startup aborted");
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`DERP exited before ready: ${output}`);
      const ready = await new Promise(resolve => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      if (attempt >= 80) throw new Error(`DERP startup timed out: ${output}`);
      await sleep(100);
    }
    const regionId = options.regionId ?? 901;
    const region = { RegionID: regionId, RegionCode: `test${regionId}`, Nodes: [{ Name: `node${regionId}`, RegionID: regionId, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", DERPPort: port, STUNPort: -1, CertName: `sha256-raw:${pin}` }] };
    return { process: child, port, region, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
