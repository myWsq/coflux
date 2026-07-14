import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

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

export function TerminalPane({
  taskId,
  sessionId,
  active,
  controlState,
  registerSessionConsumer,
  sendInput,
  sendResize,
  onReady,
  onDispose,
  onSessionReady,
  onOutput,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const activeRef = useRef(active);
  const controlStateRef = useRef(controlState);
  const sessionIdRef = useRef(sessionId);
  const callbacksRef = useRef({ onReady, onDispose, onSessionReady, onOutput });
  const transportRef = useRef({ sendInput, sendResize });

  activeRef.current = active;
  controlStateRef.current = controlState;
  sessionIdRef.current = sessionId;
  callbacksRef.current = { onReady, onDispose, onSessionReady, onOutput };
  transportRef.current = { sendInput, sendResize };

  useEffect(() => {
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
    terminal.open(hostRef.current!);
    terminalRef.current = terminal;

    const fit = () => {
      if (!activeRef.current || !hostRef.current?.isConnected) return;
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
    controllerRef.current = controller;
    callbacksRef.current.onReady(taskId, controller);

    const dataDisposable = terminal.onData((data) => {
      const currentSessionId = sessionIdRef.current;
      if (activeRef.current && controlStateRef.current === "owned" && currentSessionId) {
        transportRef.current.sendInput(currentSessionId, data);
      }
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const currentSessionId = sessionIdRef.current;
      if (activeRef.current && controlStateRef.current === "owned" && currentSessionId) {
        transportRef.current.sendResize(currentSessionId, cols, rows);
      }
    });
    const observer = new ResizeObserver(() => fit());
    observer.observe(hostRef.current!);
    if (activeRef.current) requestAnimationFrame(() => fit());

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      callbacksRef.current.onDispose(taskId, controller);
      controllerRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [taskId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const controller = controllerRef.current;
    if (!sessionId || !terminal || !controller) return;
    const unregister = registerSessionConsumer(sessionId, (data) => {
      terminal.write(data);
      callbacksRef.current.onOutput(taskId, sessionId);
    });
    callbacksRef.current.onSessionReady(taskId, sessionId, controller);
    return unregister;
  }, [registerSessionConsumer, sessionId, taskId]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!active || !controller) return;
    const frame = requestAnimationFrame(() => {
      controller.fit();
      controller.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className={active ? "absolute inset-0 block" : "absolute inset-0 hidden"} aria-hidden={!active}>
      <div ref={hostRef} className="h-full w-full px-3 py-2" />
    </div>
  );
}
