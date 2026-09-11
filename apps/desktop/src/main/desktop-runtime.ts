import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DaemonBundle } from "./daemon-bundle";
import { DAEMON_BINARIES } from "./daemon-paths";

export type RuntimeStatus = {
  ok: true;
  protocol: 1;
  instanceId: string;
  runtimeId: string;
  version: string;
  sessions: { id: string; taskId: string; pid: number }[];
};

/** 每次只发一个有界请求。实例随机标识防止退出确认跨过进程重启后误停新实例。 */
export function runtimeRequest(socketPath: string, request: { op: "status" | "stop"; instanceId?: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => finish(new Error("本机运行组件未响应，请稍后重试")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1024 * 1024) return finish(new Error("本机运行组件响应过大"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try { finish(undefined, JSON.parse(data.slice(0, end))); }
      catch { finish(new Error("本机运行组件响应无效")); }
    });
    socket.once("end", () => finish(new Error("本机运行组件响应不完整")));
  });
}

export async function runtimeStatus(home: string): Promise<RuntimeStatus | null> {
  let value: unknown;
  try { value = await runtimeRequest(join(home, "runtime.sock"), { op: "status" }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
  const status = value as Partial<RuntimeStatus> | null;
  if (!status || status.ok !== true || status.protocol !== 1 || typeof status.instanceId !== "string" ||
    typeof status.runtimeId !== "string" || typeof status.version !== "string" || !Array.isArray(status.sessions) ||
    !status.sessions.every((s) => s && typeof s.id === "string" && typeof s.taskId === "string" && typeof s.pid === "number")) {
    throw new Error("本机运行组件版本不兼容，现有终端已保留，请稍后更新");
  }
  return status as RuntimeStatus;
}

export async function stopRuntime(home: string, status: RuntimeStatus): Promise<void> {
  const result = await runtimeRequest(join(home, "runtime.sock"), { op: "stop", instanceId: status.instanceId }) as { ok?: boolean };
  if (result?.ok !== true) throw new Error("本机运行状态已变化，请重新确认");
  for (let i = 0; i < 100; i++) {
    const current = await runtimeStatus(home);
    if (!current) return;
    if (current.instanceId !== status.instanceId) throw new Error("本机出现新运行实例，已保留，请重新确认");
    await delay(50);
  }
  throw new Error("本机终端尚未结束，已取消退出");
}

/** 运行目录按内容寻址。更新 .app 不会删掉活进程使用的 worker、CLI 或插件文件。 */
export function bundleRuntimeId(bundle: DaemonBundle): string {
  const hash = createHash("sha256");
  hash.update(bundle.version ?? "dev");
  for (const binary of DAEMON_BINARIES) hash.update(readFileSync(join(bundle.dir, binary)));
  // 插件版本变化也需要新目录，但不强制重启持有旧终端的进程。
  const manifest = join(bundle.dir, "claude-plugin", ".claude-plugin", "plugin.json");
  if (existsSync(manifest)) hash.update(readFileSync(manifest));
  return hash.digest("hex").slice(0, 24);
}

export function stageRuntime(home: string, bundle: DaemonBundle, runtimeId: string): string {
  const parent = join(home, "desktop-runtimes");
  const destination = join(parent, runtimeId);
  if (existsSync(destination)) return destination;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    cpSync(bundle.dir, temporary, { recursive: true });
    for (const binary of DAEMON_BINARIES) chmodSync(join(temporary, binary), 0o755);
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return destination;
}

/** 由主应用直接启动，保持应用的权限责任链；不交给独立 LaunchAgent，也不重签二进制。 */
export async function startRuntime(home: string, directory: string, runtimeId: string, logFile: string): Promise<RuntimeStatus> {
  const existing = await runtimeStatus(home);
  if (existing) return existing;
  const temporaryHome = join(home, "terminal-data");
  mkdirSync(temporaryHome, { recursive: true, mode: 0o700 });
  const logFd = openSync(logFile, "a", 0o600);
  let launchError: Error | undefined;
  let exited = false;
  try {
    const child = spawn(join(directory, "coflux-supervisor"), [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, TMPDIR: temporaryHome, COFLUX_HOME: home, COFLUX_RUNTIME_CONTROL: "1", COFLUX_RUNTIME_ID: runtimeId,
        COFLUX_WORKER_CMD: join(directory, "coflux-worker"), COFLUX_CLAUDE_PLUGIN_DIR: join(directory, "claude-plugin") },
    });
    child.once("error", (error) => { launchError = error; });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally { closeSync(logFd); }
  for (let i = 0; i < 200; i++) {
    const status = await runtimeStatus(home);
    if (status) return status;
    if (launchError) throw launchError;
    if (exited) throw new Error("本机运行组件启动失败，请查看 Coflux 日志");
    await delay(50);
  }
  throw new Error("本机运行组件启动超时，请稍后重试");
}
