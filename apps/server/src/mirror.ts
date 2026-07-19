/**
 * SessionMirror —— server 侧终端状态镜像（tmux 式"棋局"而非"录像"）。
 *
 * 每个 RuntimeSession 挂一个 @xterm/headless 实例，实时消化 daemon 上行的 pty 字节流。
 * attach 时直接从 grid 序列化出几 KB 的重绘快照下发，不再向 daemon 要 200KB scrollback
 * 重放；daemon 离线时也能看到最后画面（本方案存在的核心理由，见 plans 讨论）。
 *
 * 真相源仍是 supervisor 的 scrollback 字节流——镜像只是物化视图：server 重启 / daemon
 * 闪断导致断档时置 primed=false，下次 attach 走原 replay 路径全量重建（prime）。
 * 未 primed 期间丢弃实时字节：断档后的增量喂进来只会产生错乱画面，不如不喂。
 */
// UMD 包：Node ESM 下无命名导出（cjs-module-lexer 解析不出），必须走 default 互操作再解构
import xtermPkg from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
const { Terminal } = xtermPkg;
const { SerializeAddon } = serializePkg;
type Terminal = InstanceType<typeof Terminal>;
type SerializeAddon = InstanceType<typeof SerializeAddon>;

// ponytail: 镜像可翻历史 2000 行（与 supervisor 200KB 字节上限同量级）；不够用再提成 config
const MIRROR_SCROLLBACK_ROWS = 2000;

export class SessionMirror {
  private term: Terminal;
  private serializer: SerializeAddon;
  /** true = 从 session 诞生起字节流连续无断档，快照可信 */
  primed: boolean;

  constructor(cols: number, rows: number, primed: boolean) {
    this.term = new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK_ROWS, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    // addon 类型声明针对 DOM 版 Terminal；headless + serialize 是官方支持组合，仅类型不兼容
    this.term.loadAddon(this.serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
    this.primed = primed;
  }

  /** 实时增量；未 primed（断档）时丢弃，等 prime 全量重建 */
  feed(data: Uint8Array): void {
    if (this.primed) this.term.write(data);
  }

  /** replay 全量到达：按发起 attach 的客户端尺寸复位后灌入，此后快照可信。
   * （server 重启后不知道 PTY 尺寸；attach 成功后 web 会 fit + ptyResize，PTY 与镜像
   * 随之收敛到同一尺寸，与旧的"客户端直接重放字节"路径的 reflow 语义一致。） */
  prime(cols: number, rows: number, data: Uint8Array): void {
    this.term.reset();
    this.term.resize(cols, rows);
    this.term.write(data);
    this.primed = true;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** 生成重绘快照（异步：xterm 的 write 是队列解析，空写回调保证在途字节已消化）。
   * 前缀 RIS（ESC c）：快照语义是"写入任意终端即重现画面"，先整体复位。 */
  snapshot(cb: (ansi: string) => void): void {
    this.term.write("", () => cb("\x1bc" + this.serializer.serialize()));
  }

  dispose(): void {
    this.term.dispose();
  }
}
