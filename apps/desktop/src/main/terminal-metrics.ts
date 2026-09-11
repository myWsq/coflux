import { monitorEventLoopDelay } from "node:perf_hooks";
import { app, ipcMain } from "electron";
import { IPC } from "../shared/ipc";
import { isTrustedRendererUrl } from "./ipc-trust";
import { ghosttyAllocatedBytes } from "./ghostty-ipc";
import type { TerminalSample } from "../shared/terminal-metrics";

export function registerTerminalMetrics(enabled: boolean, trusted: { appOrigin: string; devRendererUrl?: string }): void {
  if (!enabled) return;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  app.once("before-quit", () => loop.disable());
  let lastSample = 0;
  ipcMain.on(IPC.terminalMetricsRequest, (event, requestId: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame?.url, trusted)) return;
    if (typeof requestId !== "string" || requestId.length > 128 || Date.now() - lastSample < 100) return;
    lastSample = Date.now();
    const sample: TerminalSample = {
      requestId, at: Date.now(), mainRss: process.memoryUsage().rss,
      mainLoopMaxMs: loop.max / 1e6, mainLoopP99Ms: loop.percentile(99) / 1e6,
      metalAllocatedBytes: ghosttyAllocatedBytes(),
      processes: app.getAppMetrics().map((metric) => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage, workingSetKB: metric.memory.workingSetSize })),
    };
    loop.reset();
    event.sender.send(IPC.terminalMetricsSample, sample);
  });
}
