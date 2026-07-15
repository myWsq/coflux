import { createEffect, on, onCleanup, onMount } from "solid-js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** 控制权四态：detached 下输入锁定是安全语义（他端已接管），不是体验细节。 */
export type TerminalControlState = "stopped" | "attaching" | "owned" | "detached";

export type TerminalController = {
  dimensions: () => { cols: number; rows: number };
  fit: () => void;
  focus: () => void;
  reset: () => void;
  writeSystem: (message: string, tone?: "warning" | "error") => void;
};

type TerminalPaneProps = {
  taskId: string;
  sessionId: string | null;
  active: boolean;
  controlState: TerminalControlState;
  registerSessionConsumer: (sessionId: string, consumer: (data: Uint8Array) => void) => () => void;
  sendInput: (sessionId: string, data: string) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  onReady: (taskId: string, controller: TerminalController) => void;
  onDispose: (taskId: string, controller: TerminalController) => void;
  onSessionReady: (taskId: string, sessionId: string, controller: TerminalController) => void;
  onOutput: (taskId: string, sessionId: string) => void;
};

export function TerminalPane(props: TerminalPaneProps) {
  let host!: HTMLDivElement;

  onMount(() => {
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e4",
        cursor: "#e4e4e4",
        selectionBackground: "#3a3a3a88",
        black: "#1a1a1a",
        brightBlack: "#6a6a6a",
        red: "#e05c6a",
        green: "#4fae6e",
        yellow: "#c9a227",
        blue: "#6b9bd1",
        magenta: "#b07cc6",
        cyan: "#56b6c2",
        white: "#d4d4d4",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    // WebGL 渲染器动态加载（addon 约 247KB，不进首屏主 chunk）：
    // context 丢失（息屏/切显卡/驱动重置）时 dispose addon，xterm 自动回退
    // DOM 渲染器，避免白屏；实例化或 chunk 加载失败同样静默回退。
    let disposed = false;
    import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed || !terminal.element) return; // 面板已卸载则不再挂载
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminal.loadAddon(webgl);
        } catch {
          // WebGL 不可用（无硬件加速/被禁用），保持默认 DOM 渲染器。
        }
      })
      .catch(() => {
        // chunk 加载失败（离线/网络异常），保持默认 DOM 渲染器。
      });

    const fit = () => {
      if (!props.active || !host.isConnected) return;
      try {
        fitAddon.fit();
      } catch {
        // 容器切换显示的瞬间可能尚无可测尺寸，下一次观察回调会再次 fit。
      }
    };
    const controller: TerminalController = {
      dimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      fit,
      focus: () => terminal.focus(),
      reset: () => {
        terminal.reset();
        terminal.clear();
      },
      writeSystem: (message, tone = "warning") => {
        const color = tone === "error" ? "31" : "33";
        terminal.writeln(`\r\n\x1b[${color}m[${message}]\x1b[0m`);
      },
    };
    props.onReady(props.taskId, controller);

    // 输入/resize 只在 active && owned 时发送（安全语义，见 TerminalControlState）。
    terminal.onData((data) => {
      const sessionId = props.sessionId;
      if (props.active && props.controlState === "owned" && sessionId) props.sendInput(sessionId, data);
    });
    terminal.onResize(({ cols, rows }) => {
      const sessionId = props.sessionId;
      if (props.active && props.controlState === "owned" && sessionId) props.sendResize(sessionId, cols, rows);
    });

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    if (props.active) requestAnimationFrame(() => fit());

    // sessionReady 门控：先注册 ptyOutput consumer，再通知上层可以 attach——
    // 否则 attach 回放的 scrollback 字节会在 consumer 注册前到达而丢失。
    createEffect(
      on(
        () => props.sessionId,
        (sessionId) => {
          if (!sessionId) return;
          const unregister = props.registerSessionConsumer(sessionId, (data) => {
            terminal.write(data);
            props.onOutput(props.taskId, sessionId);
          });
          props.onSessionReady(props.taskId, sessionId, controller);
          onCleanup(unregister);
        },
      ),
    );

    createEffect(
      on(
        () => props.active,
        (active) => {
          if (!active) return;
          const frame = requestAnimationFrame(() => {
            controller.fit();
            controller.focus();
          });
          onCleanup(() => cancelAnimationFrame(frame));
        },
      ),
    );

    onCleanup(() => {
      disposed = true;
      observer.disconnect();
      props.onDispose(props.taskId, controller);
      terminal.dispose(); // 一并 dispose 已挂载的 addons（fit/webgl）与输入监听
    });
  });

  // Tab 切换用 display 隐藏而非卸载：卸载 xterm 会丢 scrollback 与选区。
  return (
    <div class={props.active ? "absolute inset-0 block" : "absolute inset-0 hidden"} aria-hidden={!props.active}>
      <div ref={host} class="h-full w-full px-3 py-2" />
    </div>
  );
}
