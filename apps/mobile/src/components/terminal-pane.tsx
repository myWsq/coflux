import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** 控制权状态：与桌面端 workbench/terminal-pane.tsx 同一份语义（detached 下输入锁定是
 * 安全语义，非体验细节）。移动端不做隐藏保活矩阵，但同一工作区内的多个 Tab 仍靠
 * display 切换保留 scrollback，故 active 概念照搬。 */
export type TerminalControlState = "stopped" | "idle" | "attaching" | "owned" | "detached";

export type TerminalController = {
  dimensions: () => { cols: number; rows: number };
  fit: () => void;
  focus: () => void;
  reset: () => void;
  writeSystem: (message: string, tone?: "warning" | "error" | "success") => void;
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
  // 快捷键条的粘滞 Ctrl（plan 032）：武装后拦截真实键盘/输入法送来的下一个字符，
  // 转成对应控制字节；由 onData 里实施（复用系统键盘做字母源，不用另画一套字母键盘）。
  ctrlArmed: boolean;
  onCtrlConsumed: () => void;
};

/** xterm 6.0.0 私有内部结构（仅补丁用到的字段），升级 @xterm/xterm 需复验。 */
type XtermCoreInternals = {
  _compositionHelper?: { _isComposing: boolean; _isSendingComposition: boolean; _handleAnyTextareaChanges: () => void };
  _inputEvent?: (ev: InputEvent) => boolean;
  _keyPressHandled?: boolean;
  _unprocessedDeadKey?: boolean;
  coreService?: { triggerDataEvent: (data: string, wasUserInput: boolean) => void };
  textarea?: HTMLTextAreaElement;
  cancel?: (ev: Event) => void;
};

/** 全角标点丢字 workaround（上游 xtermjs/xterm.js#5887），与 apps/web 同一份补丁：
 * 中文 IME 直接提交的字符只出现在 textarea 'input' 事件里，上游 _inputEvent 门控会挡住，
 * 兜底 diff 路径又与 IME 落字时序竞态。任一内部字段缺失（日后升级 xterm 内部改名）
 * 则整体跳过，行为回落为上游现状。 */
function patchImeCommittedInput(terminal: Terminal): void {
  const core = (terminal as unknown as { _core?: XtermCoreInternals })._core;
  const helper = core?._compositionHelper;
  const origInputEvent = core?._inputEvent;
  if (!core || !helper || !origInputEvent || !core.coreService || !core.textarea || !core.cancel) return;

  helper._handleAnyTextareaChanges = () => {};
  core._inputEvent = (ev: InputEvent) => {
    if (helper._isComposing || helper._isSendingComposition) return false;
    if (ev.inputType === "insertText" && ev.data && !core._keyPressHandled) {
      core._unprocessedDeadKey = false;
      core.coreService!.triggerDataEvent(ev.data, true);
      core.textarea!.value = "";
      core.cancel!(ev);
      return true;
    }
    if (ev.inputType === "deleteContentBackward") {
      core.coreService!.triggerDataEvent("\x7f", true);
      core.textarea!.value = "";
      core.cancel!(ev);
      return true;
    }
    return origInputEvent.call(core, ev);
  };
}

export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const controllerRef = useRef<TerminalController | null>(null);

  // 闭包只捕获创建时的值，而 onData/onResize 要读"当下"的 active/controlState/ctrlArmed 等，
  // 故镜像进 ref（同桌面端 terminal-pane.tsx 手法）。
  const liveRef = useRef({
    active: props.active,
    controlState: props.controlState,
    sessionId: props.sessionId,
    sendInput: props.sendInput,
    sendResize: props.sendResize,
    ctrlArmed: props.ctrlArmed,
    onCtrlConsumed: props.onCtrlConsumed,
  });
  useEffect(() => {
    liveRef.current = {
      active: props.active,
      controlState: props.controlState,
      sessionId: props.sessionId,
      sendInput: props.sendInput,
      sendResize: props.sendResize,
      ctrlArmed: props.ctrlArmed,
      onCtrlConsumed: props.onCtrlConsumed,
    };
  });

  // 挂载时创建 xterm 等命令式资源，只跑一次：TerminalPane 以 taskId 为 React key，
  // 同一实例生命周期内 taskId 不变，无需把 props 列进依赖数组。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000, // 移动端离开工作区详情页即整体卸载，无需桌面端 1 万行的保活预算
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
    patchImeCommittedInput(terminal);
    terminalRef.current = terminal;

    const fit = () => {
      if (!liveRef.current.active || !host.isConnected) return;
      // 0 尺寸（Tab 切换 display:none 期间）一律不 fit：FitAddon 会把终端钳到 2×1
      // 并经 onResize 把 2×1 传给远程 PTY，污染远端 TUI 布局/镜像。
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
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
        const color = tone === "error" ? "31" : tone === "success" ? "32" : "33";
        terminal.writeln(`\r\n\x1b[${color}m[${message}]\x1b[0m`);
      },
    };
    controllerRef.current = controller;
    props.onReady(props.taskId, controller);

    // 输入/resize 只在 active && owned 时发送（安全语义，见 TerminalControlState）。
    terminal.onData((data) => {
      const { active, controlState, sessionId, sendInput, ctrlArmed, onCtrlConsumed } = liveRef.current;
      if (!(active && controlState === "owned" && sessionId)) return;
      // 粘滞 Ctrl：武装态下拦截下一个字符，单个 ASCII 字母才转换成控制字节，
      // 其余字符（含多字节/组合键序列）原样放行并照样解除武装，避免卡死在武装态。
      if (ctrlArmed) {
        onCtrlConsumed();
        if (data.length === 1) {
          const code = data.charCodeAt(0);
          const lower = data.toLowerCase().charCodeAt(0);
          if (lower >= 97 && lower <= 122) {
            sendInput(sessionId, String.fromCharCode(code & 0x1f));
            return;
          }
        }
      }
      sendInput(sessionId, data);
    });
    terminal.onResize(({ cols, rows }) => {
      const { active, controlState, sessionId, sendResize } = liveRef.current;
      if (active && controlState === "owned" && sessionId) sendResize(sessionId, cols, rows);
    });

    // xterm 6.0 的滚动实现自 VS Code 移植（scrollable-element + Gesture 手势系统），
    // 但其 Gesture.addTarget 在打包产物中零调用——触摸滑动从未接入滚动，只有 wheel
    // 路径可用（上游缺陷，桌面不受影响）。这里自补：touchmove 位移按 cell 高度换算
    // 行数走公开 API scrollLines；只拦截 move（tap 聚焦/软键盘不受影响），
    // preventDefault 阻止页面级橡皮筋回弹。升级 @xterm/xterm 时复验是否已修。
    // 松手后按指数衰减续滚（iOS 式动量，时间常数 325ms）；新触摸立即打断。
    let touchLastY: number | null = null;
    let touchAccum = 0;
    let touchVelocity = 0; // px/ms，低通滤波后的滑动速度
    let touchLastMoveAt = 0;
    let momentumFrame: number | null = null;

    const stopMomentum = () => {
      if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
      }
    };
    // 位移累积进 touchAccum，攒满一个 cell 高度才折算成 scrollLines（move 与动量共用）。
    const scrollByPixels = (pixels: number) => {
      touchAccum += pixels;
      const screen = host.querySelector(".xterm-screen");
      const cellHeight = screen && terminal.rows > 0 ? screen.clientHeight / terminal.rows : 0;
      if (cellHeight <= 0) return;
      const lines = Math.trunc(touchAccum / cellHeight);
      if (lines !== 0) {
        touchAccum -= lines * cellHeight;
        terminal.scrollLines(lines);
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      stopMomentum();
      touchLastY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
      touchAccum = 0;
      touchVelocity = 0;
      touchLastMoveAt = performance.now();
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (touchLastY === null || event.touches.length !== 1) return;
      event.preventDefault();
      const y = event.touches[0]!.clientY;
      const dy = touchLastY - y;
      touchLastY = y;
      const now = performance.now();
      const dt = now - touchLastMoveAt;
      touchLastMoveAt = now;
      if (dt > 0) touchVelocity = 0.8 * (dy / dt) + 0.2 * touchVelocity; // 低通：抑制单帧抖动
      scrollByPixels(dy);
    };
    const handleTouchEnd = () => {
      touchLastY = null;
      // 手指停稳再抬（>80ms 无移动）视为精确定位，不给动量；快甩才续滚。
      if (performance.now() - touchLastMoveAt > 80 || Math.abs(touchVelocity) < 0.15) return;
      let velocity = touchVelocity;
      let prev = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = now - prev;
        prev = now;
        scrollByPixels(velocity * dt);
        velocity *= Math.exp(-dt / 325);
        if (Math.abs(velocity) < 0.02) {
          momentumFrame = null;
          return;
        }
        momentumFrame = requestAnimationFrame(tick);
      };
      momentumFrame = requestAnimationFrame(tick);
    };
    host.addEventListener("touchstart", handleTouchStart, { passive: true });
    host.addEventListener("touchmove", handleTouchMove, { passive: false });
    host.addEventListener("touchend", handleTouchEnd);
    host.addEventListener("touchcancel", handleTouchEnd);

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    if (props.active) requestAnimationFrame(() => fit());

    return () => {
      observer.disconnect();
      stopMomentum();
      host.removeEventListener("touchstart", handleTouchStart);
      host.removeEventListener("touchmove", handleTouchMove);
      host.removeEventListener("touchend", handleTouchEnd);
      host.removeEventListener("touchcancel", handleTouchEnd);
      props.onDispose(props.taskId, controller);
      terminal.dispose();
      terminalRef.current = null;
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // sessionReady 门控：先注册 ptyOutput consumer，再通知上层可以 attach——
  // 否则 attach 回放的 scrollback 字节会在 consumer 注册前到达而丢失。
  useEffect(() => {
    const sessionId = props.sessionId;
    const terminal = terminalRef.current;
    const controller = controllerRef.current;
    if (!sessionId || !terminal || !controller) return;
    const unregister = props.registerSessionConsumer(sessionId, (data) => {
      terminal.write(data);
      props.onOutput(props.taskId, sessionId);
    });
    props.onSessionReady(props.taskId, sessionId, controller);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.active) return;
    const frame = requestAnimationFrame(() => {
      controllerRef.current?.fit();
      controllerRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.active]);

  // Tab 切换用 display 隐藏而非卸载：卸载 xterm 会丢 scrollback 与选区。
  return (
    <div className={props.active ? "absolute inset-0 block" : "absolute inset-0 hidden"} aria-hidden={!props.active}>
      <div ref={hostRef} className="h-full w-full pb-2 pl-2 pt-1" />
    </div>
  );
}
