import type { Terminal } from '@xterm/xterm';

// 与原生 measureInputRoundtrip 使用相同 PTY 程序、探针次数与视口轮询终点。
export async function measureInput(terminal: Terminal, outputLoad: boolean,
  send: (data: string) => void, viewport: () => string) {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const ready = 'RT-READY-' + crypto.randomUUID();
  const code = `import os,tty,termios,select,time
load = ${outputLoad ? 'True' : 'False'}
load_bytes = 0
next_output = time.monotonic()
payload = ("\\x1b[32m持续输出 中文 emoji 🚀 " + "x" * 64 + "\\x1b[0m\\r\\n").encode() * 16
previous = termios.tcgetattr(0)
try:
    tty.setraw(0)
    os.write(1, b"${ready}\\r\\n")
    pending = b""
    while True:
        if load and time.monotonic() >= next_output:
            os.write(1, payload)
            load_bytes += len(payload)
            next_output = time.monotonic() + 0.005
        if not select.select([0], [], [], 0.001)[0]:
            continue
        value = os.read(0,1)
        if value == b"\\x04":
            break
        if value in (b"\\r",b"\\n"):
            os.write(1,b"ACK:"+pending+b":loadBytes="+str(load_bytes).encode()+b"\\r\\n")
            pending = b""
        else:
            pending += value
finally:
    termios.tcsetattr(0,termios.TCSANOW,previous)
`;
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(code)));
  send(`python3 -u -c "import base64;exec(base64.b64decode('${encoded}'))"\r`);
  const samples: number[] = []; let observedLoadBytes = 0;
  try {
    const deadline = performance.now() + 20000;
    while (!Array.from({length: terminal.buffer.active.length}, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n').includes(ready)) {
      if (performance.now() > deadline) throw new Error('PTY 探针程序未就绪');
      await sleep(30);
    }
    for (let index = 0; index < 31; index++) {
      if (outputLoad) await sleep(20);
      const response = 'ACK:probe-' + index + '-' + crypto.randomUUID();
      const start = performance.now();
      terminal.input(response.slice(4), true); terminal.input('\r', true);
      while (!viewport().includes(response)) {
        if (performance.now() - start > 5000) throw new Error('终端输入未收到 PTY 确认');
        await sleep(1);
      }
      samples.push(performance.now() - start);
      if (outputLoad) {
        const suffix = viewport().split(response + ':loadBytes=')[1];
        const count = Number(suffix?.match(/^\d+/)?.[0]);
        if (!Number.isFinite(count) || count <= observedLoadBytes) throw new Error('每个探针间必须有新 PTY 输出');
        observedLoadBytes = count;
      }
    }
    const measured = samples.slice(1), sorted = [...measured].sort((a,b) => a-b);
    return {samplesMS: measured, warmupMS: samples[0], outputLoad, observedLoadBytes,
      medianMS: (sorted[14]! + sorted[15]!) / 2, p95MS: sorted[28], cols: terminal.cols, rows: terminal.rows,
      scope: '真实 Workbench；xterm.input 文本及回车→隔离 relay→PTY ACK→当前视口；1ms轮询，非物理键盘或GPU呈现'};
  } finally { send('\x04'); }
}
