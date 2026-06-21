/** exec 原语：在某 cwd 下跑一次性命令，捕获 stdout/stderr/exitCode。 */
import { execFile } from "node:child_process";

export interface ExecOutcome {
  ok: boolean; // 是否成功跑完（即便非零退出码也算跑完）；spawn 失败/超时为 false
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export function runCommand(
  cwd: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<ExecOutcome> {
  return new Promise((res) => {
    execFile(
      command,
      Array.isArray(args) ? args : [],
      {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        const out = stdout ?? "";
        const errOut = stderr ?? "";
        if (!err) {
          res({ ok: true, exitCode: 0, stdout: out, stderr: errOut });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        if (typeof e.code === "number") {
          // 跑完了但非零退出
          res({ ok: true, exitCode: e.code, stdout: out, stderr: errOut });
        } else {
          // 区分失败类型，给出可辨识的 error（spawn 失败 / 超时被杀 / 输出超限截断）
          let error: string;
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") error = "输出超过上限，已截断";
          else if (e.killed || e.signal) error = `进程被终止（${e.signal ?? "killed"}，可能超时）`;
          else error = String(e.code ?? err.message);
          res({ ok: false, exitCode: -1, stdout: out, stderr: errOut, error });
        }
      },
    );
  });
}
