/* 编排者粘贴到桌面 DevTools console；不自动执行测量或输入。 */
(() => {
  const bridge = window.cofluxDesktop;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.cofluxSpike = {
    dump(taskId) {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener("coflux:ghostty-dump-result", handler); reject(new Error("dump 超时")); }, 15000);
        const handler = (event) => {
          if (event.detail.requestId !== requestId) return;
          clearTimeout(timer); window.removeEventListener("coflux:ghostty-dump-result", handler); resolve(event.detail);
        };
        window.addEventListener("coflux:ghostty-dump-result", handler);
        window.dispatchEvent(new CustomEvent("coflux:ghostty-dump", { detail: { requestId, taskId } }));
      });
    },
    resume() { window.dispatchEvent(new Event("coflux:ghostty-resume")); },
    async measure({ seconds = 60, label = "visible", probes = true } = {}) {
      if (!bridge.terminalMetrics.enabled) throw new Error("以 COFLUX_TERMINAL_METRICS=1 启动再测量");
      const samples = [], latency = [], frameGaps = [];
      let stopped = false, previous = performance.now();
      const frame = (now) => { frameGaps.push(now - previous); previous = now; if (!stopped) requestAnimationFrame(frame); };
      const onLatency = (event) => latency.push(event.detail.latency);
      const off = bridge.terminalMetrics.onSample((sample) => samples.push(sample));
      window.addEventListener("coflux:terminal-latency", onLatency);
      requestAnimationFrame(frame);
      for (let second = 0; second < seconds; second++) {
        bridge.terminalMetrics.sample(crypto.randomUUID());
        if (probes) window.dispatchEvent(new CustomEvent("coflux:terminal-probe", { detail: { id: crypto.randomUUID() } }));
        await delay(1000);
      }
      stopped = true; off(); window.removeEventListener("coflux:terminal-latency", onLatency);
      const queuePeak = Math.max(0, ...[...document.querySelectorAll("[data-ghostty-peak-bytes]")].map((element) => Number(element.dataset.ghosttyPeakBytes)));
      return { engine: bridge.ghostty.enabled ? "ghostty" : "xterm", label, seconds, probes, latency, frameGaps, queuePeak, samples, latencyDefinition: "sendInput 到 PONG 所在输出解析完成；不代表像素呈现", environment: { dpr: devicePixelRatio, viewport: [innerWidth, innerHeight] } };
    },
  };
  console.log("已安装 cofluxSpike.dump/resume/measure；未执行任何输入或测量。");
})();
