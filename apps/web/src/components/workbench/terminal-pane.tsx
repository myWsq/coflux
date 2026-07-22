import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useToast } from "@astryxdesign/core/Toast";
import type { FsWriteResult } from "@/client/store";

/** 控制权状态：detached 下输入锁定是安全语义（他端已接管），不是体验细节。
 * idle = RUNNING 但本端未申请控制权（旁观 / 后台面板），仅用于 Tab 图标呈现为中性态，
 * 输入门控与 attaching/stopped 一致（下方 owned 判等），不需要单独处理。 */
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
  workspaceId: string;
  active: boolean;
  controlState: TerminalControlState;
  registerSessionConsumer: (sessionId: string, consumer: (data: Uint8Array) => void) => () => void;
  sendInput: (sessionId: string, data: string) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  sendFsWrite: (workspaceId: string, path: string, data: Uint8Array, temp: boolean) => Promise<FsWriteResult>;
  onReady: (taskId: string, controller: TerminalController) => void;
  onDispose: (taskId: string, controller: TerminalController) => void;
  onSessionReady: (taskId: string, sessionId: string, controller: TerminalController) => void;
  onOutput: (taskId: string, sessionId: string) => void;
};

// 终端贴图（plan 014）的压缩目标独立于文件上传上限，保持 3.5MB 以节省截图传输带宽。
const PASTE_BUDGET_BYTES = 3.5 * 1024 * 1024;
const PASTE_MIN_DIMENSION = 64; // 降分辨率的下限：避免退化成不可读的一两个像素
// 拖拽文件上传上限须与 server maxPayload、worker MAX_WRITE_BYTES 同为 30MB；任一偏小都会让前端放行后被下游拒绝。
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

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

/** 全角标点丢字 workaround（上游 xtermjs/xterm.js#5887，6.1.0-beta 仍未修）：
 * 中文 IME 直接提交（无 composition 会话）的字符只出现在 textarea 'input' 事件里，
 * 但 xterm 的 _inputEvent 被 (!ev.composed || !_keyDownSeen) 门控挡住，兜底的
 * CompositionHelper setTimeout(0) textarea diff 又与 IME 落字时序竞态——
 * 表现为全角 ？！ 等（带 Shift 的标点）需连输两次才出一个。
 * 这里改为由 input 事件确定性发送并停用竞态 diff 路径；任一内部字段缺失
 * （日后升级 xterm 内部改名）则整体跳过，行为回落为上游现状。 */
function patchImeCommittedInput(terminal: Terminal): void {
  const core = (terminal as unknown as { _core?: XtermCoreInternals })._core;
  const helper = core?._compositionHelper;
  const origInputEvent = core?._inputEvent;
  if (!core || !helper || !origInputEvent || !core.coreService || !core.textarea || !core.cancel) return;

  helper._handleAnyTextareaChanges = () => {};
  core._inputEvent = (ev: InputEvent) => {
    if (helper._isComposing || helper._isSendingComposition) return false;
    // Alt/Option 组合字符走 keypress 已发过（_keyPressHandled），不能重复发。
    if (ev.inputType === "insertText" && ev.data && !core._keyPressHandled) {
      core._unprocessedDeadKey = false;
      core.coreService!.triggerDataEvent(ev.data, true);
      core.textarea!.value = ""; // 及时清空，textarea 累积残值正是上游 diff 路径不可靠的来源之一
      core.cancel!(ev);
      return true;
    }
    if (ev.inputType === "deleteContentBackward") {
      // 对应被停用的 diff 路径里"值变短发 DEL"分支（IME 吞掉 Backspace keydown 的场景）
      core.coreService!.triggerDataEvent("\x7f", true);
      core.textarea!.value = "";
      core.cancel!(ev);
      return true;
    }
    return origInputEvent.call(core, ev);
  };
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** 拖拽上传使用生成式单段文件名，原扩展名只保留安全的 ASCII 字母数字，避免 temp 路径校验失败。 */
function safeDropExtension(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]{1,16})$/);
  return match ? `.${match[1]}` : "";
}

function fileFromDragItem(item: DataTransferItem): File | null {
  if (item.kind !== "file") return null;
  // 只借 entry 标记区分文件与目录，不递归展开目录；不支持该 API 的浏览器回落到标准 getAsFile。
  const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isFile: boolean } | null }).webkitGetAsEntry?.();
  if (entry && !entry.isFile) return null;
  return item.getAsFile();
}

/** 把图片压缩到预算内：先在原分辨率按 JPEG 质量阶梯降（文字截图的可读性损失最小），
 * 仍超限再减半分辨率重来；两者都到头仍超限则回落已压出的最小结果（上传若仍失败，由调用方报错）。 */
async function compressToBudget(blob: Blob, budget: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  let width = bitmap.width;
  let height = bitmap.height;
  const qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  let smallest: Blob | null = null;
  while (true) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of qualities) {
      const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!encoded) continue;
      if (!smallest || encoded.size < smallest.size) smallest = encoded;
      if (encoded.size <= budget) return new Uint8Array(await encoded.arrayBuffer());
    }
    if (Math.min(width, height) <= PASTE_MIN_DIMENSION) break;
    width /= 2;
    height /= 2;
  }
  return new Uint8Array(await (smallest ?? blob).arrayBuffer());
}

export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // 上传中用光标转圈表达进行态；成功不打扰，只在失败时弹 toast 告知原因——不写进终端画面避免污染 claude 会话。
  const [isUploading, setIsUploading] = useState(false);
  const showToast = useToast();

  // onData/onResize/粘贴/拖拽处理在挂载时注册一次，但要读到"当下"的 active/controlState/sessionId 等——
  // React 组件体每次渲染都跑而闭包只捕获创建时的值，故镜像进 ref（landmine 17：untrack 无直接对应物，
  // 这里反过来是"始终读最新"而非"读一次"，用同样的 ref 手段解决）。
  const liveRef = useRef({
    active: props.active,
    controlState: props.controlState,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    sendInput: props.sendInput,
    sendResize: props.sendResize,
    sendFsWrite: props.sendFsWrite,
    showToast,
  });
  useEffect(() => {
    liveRef.current = {
      active: props.active,
      controlState: props.controlState,
      sessionId: props.sessionId,
      workspaceId: props.workspaceId,
      sendInput: props.sendInput,
      sendResize: props.sendResize,
      sendFsWrite: props.sendFsWrite,
      showToast,
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
      fontSize: 12, // 等宽字体同 px 视觉大于 UI sans（页面 base 13px），降 1px 找平衡（VS Code 同款配比）
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
    terminal.loadAddon(new WebLinksAddon()); // 输出中的 URL 可点击（默认 window.open 新开 Tab）
    terminal.open(host);
    patchImeCommittedInput(terminal);
    terminalRef.current = terminal;

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
          fit(); // WebGL 用字形图集重新度量 cell，尺寸可能与挂载时的 DOM 渲染器度量有亚像素差异，补一次 fit 对齐
        } catch {
          // WebGL 不可用（无硬件加速/被禁用），保持默认 DOM 渲染器。
        }
      })
      .catch(() => {
        // chunk 加载失败（离线/网络异常），保持默认 DOM 渲染器。
      });

    const fit = () => {
      if (!liveRef.current.active || !host.isConnected) return;
      // 工作区保活模式下被 display:none 隐藏时尺寸为 0：FitAddon 会把终端钳到 2×1
      // 并经 onResize 把 2×1 传给远程 PTY（远端 TUI 按 2 列重排，切回闪残影、污染镜像）。
      // 0 尺寸一律不 fit，切回显示后 WorkspaceTerminal 的 rAF fit 会用真实尺寸补上。
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
      const { active, controlState, sessionId, sendInput } = liveRef.current;
      if (active && controlState === "owned" && sessionId) sendInput(sessionId, data);
    });
    terminal.onResize(({ cols, rows }) => {
      const { active, controlState, sessionId, sendResize } = liveRef.current;
      if (active && controlState === "owned" && sessionId) sendResize(sessionId, cols, rows);
    });

    // 剪贴板贴图（plan 014）：capture 阶段挂在 host（xterm textarea 的祖先）上，
    // 抢在 xterm 自己给 textarea 注册的 paste 监听之前拦截——只处理 image/*，
    // 文本粘贴不 preventDefault，原样落到 xterm 默认行为，行为不变。
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageItem = [...items].find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      event.preventDefault();
      event.stopPropagation();

      const { active, controlState, sessionId, workspaceId, sendFsWrite } = liveRef.current;
      if (!(active && controlState === "owned" && sessionId)) {
        controllerRef.current?.writeSystem("未持有控制权，无法粘贴图片", "warning");
        return;
      }
      const blob = imageItem.getAsFile();
      if (!blob) return;

      void (async () => {
        try {
          const bytes =
            blob.size > PASTE_BUDGET_BYTES ? await compressToBudget(blob, PASTE_BUDGET_BYTES) : new Uint8Array(await blob.arrayBuffer());
          const ext = extForMime(blob.size > PASTE_BUDGET_BYTES ? "image/jpeg" : blob.type);
          const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          // temp=true：落 daemon 侧系统临时目录，name 是单段文件名（不拼目录前缀）；
          // 回带的 result.path 是 worker 侧确定的绝对路径，直接注入。
          const result = await sendFsWrite(workspaceId, name, bytes, true);
          if (result.ok && result.path) {
            terminal.paste(` ${result.path} `);
          } else {
            controllerRef.current?.writeSystem(`图片上传失败：${result.error}`, "error");
          }
        } catch (e) {
          controllerRef.current?.writeSystem(`图片处理失败：${e instanceof Error ? e.message : String(e)}`, "error");
        }
      })();
    };
    host.addEventListener("paste", handlePaste, { capture: true });

    const hasFileTransfer = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const handleDragEnter = (event: DragEvent) => {
      if (!hasFileTransfer(event)) return;
      event.preventDefault();
      setIsDraggingFile(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!hasFileTransfer(event)) return;
      event.preventDefault(); // 必须拦截，否则浏览器会拒绝 drop 或把文件导航到当前页面。
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setIsDraggingFile(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      const nextTarget = event.relatedTarget;
      // host 内子元素之间移动会冒泡出 dragleave；只有真正离开整个终端区域才隐藏遮罩。
      if (nextTarget instanceof Node && host.contains(nextTarget)) return;
      setIsDraggingFile(false);
    };
    const handleDrop = (event: DragEvent) => {
      event.preventDefault(); // 防止浏览器用拖入文件替换当前页面。
      setIsDraggingFile(false);

      const files = Array.from(event.dataTransfer?.items ?? []).map(fileFromDragItem).filter((file): file is File => file !== null);
      if (files.length === 0) return; // 文件夹不递归展开，也不打扰用户。

      const { active, controlState, sessionId, workspaceId, sendFsWrite, showToast } = liveRef.current;
      if (!(active && controlState === "owned" && sessionId)) {
        showToast({ body: "未持有控制权，无法上传文件", type: "error" });
        return;
      }

      const uploadableFiles = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
      const rejectedCount = files.length - uploadableFiles.length;
      if (rejectedCount > 0) {
        showToast({ body: `${rejectedCount} 个文件超过 30MB，已拒绝上传`, type: "error" });
      }
      if (uploadableFiles.length === 0) return;

      setIsUploading(true);
      void (async () => {
        const uploadedPaths: string[] = [];
        for (const file of uploadableFiles) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const name = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeDropExtension(file.name)}`;
            const result = await sendFsWrite(workspaceId, name, bytes, true);
            if (result.ok && result.path) {
              uploadedPaths.push(result.path);
            } else {
              showToast({ body: `文件上传失败：${result.error}`, type: "error" });
            }
          } catch (e) {
            showToast({ body: `文件上传失败：${e instanceof Error ? e.message : String(e)}`, type: "error" });
          }
        }
        setIsUploading(false);
        if (uploadedPaths.length > 0) {
          terminal.paste(` ${uploadedPaths.join(" ")} `);
        }
      })();
    };
    host.addEventListener("dragenter", handleDragEnter);
    host.addEventListener("dragover", handleDragOver);
    host.addEventListener("dragleave", handleDragLeave);
    host.addEventListener("drop", handleDrop);

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    if (props.active) requestAnimationFrame(() => fit());

    // devicePixelRatio 变化（浏览器缩放、拖跨不同缩放比的显示器）后 xterm 按新 dpr
    // 重新取整 cell 尺寸，host CSS 尺寸不变、ResizeObserver 不会触发，需主动补 fit。
    // media query 字符串绑定的是创建时的 dpr 值，change 只在离开该值时触发一次，
    // 故每次触发后以新 dpr 自递归重建监听。
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      fit();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange, { once: true });
    };
    watchDpr();

    return () => {
      disposed = true;
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
      host.removeEventListener("paste", handlePaste, { capture: true });
      host.removeEventListener("dragenter", handleDragEnter);
      host.removeEventListener("dragover", handleDragOver);
      host.removeEventListener("dragleave", handleDragLeave);
      host.removeEventListener("drop", handleDrop);
      props.onDispose(props.taskId, controller);
      terminal.dispose(); // 一并 dispose 已挂载的 addons（fit/webgl）与输入监听
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
      <div ref={hostRef} className={`h-full w-full pb-3 pl-3 pt-2${isUploading ? " cursor-progress [&_*]:cursor-progress" : ""}`} />
      {isDraggingFile ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border border-warning/20 bg-warning/10 text-sm font-medium text-warning backdrop-blur">
          松开上传
        </div>
      ) : null}
    </div>
  );
}
