import { readFileSync } from "node:fs";
const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error("用法：compare-perf.mjs xterm.json ghostty.json");
const [xterm, ghostty] = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
if (xterm.engine !== "xterm" || ghostty.engine !== "ghostty") throw new Error("输入文件引擎不匹配");
function percentile(values, p) {
  if (!values.length) return "未采到";
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2));
}
const metrics = {
  "输入→解析 P95(ms)": (run) => percentile(run.latency, .95),
  "主线程 loop P99(ms) 的峰值": (run) => percentile(run.samples.map((sample) => sample.mainLoopP99Ms), 1),
  "渲染页面 rAF 间隔 P95(ms)": (run) => percentile(run.frameGaps, .95),
  "未解析队列峰值(bytes)": (run) => run.queuePeak,
  "主进程 RSS 峰值(bytes)": (run) => percentile(run.samples.map((sample) => sample.mainRss), 1),
  "全部进程工作集峰值(KB)": (run) => percentile(run.samples.map((sample) => sample.processes.reduce((sum, process) => sum + process.workingSetKB, 0)), 1),
  "全部进程 CPU 中位数(%)": (run) => percentile(run.samples.map((sample) => sample.processes.reduce((sum, process) => sum + process.cpu, 0)), .5),
  "Metal device allocated 峰值(bytes)": (run) => percentile(run.samples.map((sample) => sample.metalAllocatedBytes).filter((value) => value !== null), 1),
  "PONG 样本数": (run) => run.latency.length,
};
console.log(`场景：${xterm.label} / ${ghostty.label}`);
console.table(Object.entries(metrics).map(([metric, fn]) => ({ metric, xterm: fn(xterm), Ghostty: fn(ghostty) })));
console.log("实际 GPU 呈现延迟及 xterm Metal 内存需 Instruments 补录；rAF 不是 Metal frame。隐藏 Tab CPU 用 label=hidden-10、probes=false 再各采一份。");
if (!xterm.samples.length || !ghostty.samples.length || (xterm.probes && !xterm.latency.length) || (ghostty.probes && !ghostty.latency.length)) process.exitCode = 1;
