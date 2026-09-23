import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ScrollText, X } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import {
  loadTranscript,
  type TranscriptEntry,
  type TranscriptExec,
  type TranscriptResult,
} from "@/components/workbench/terminal-transcript";

/**
 * The conversation behind a terminal, as a page you can read and copy (plan 20260919).
 *
 * Why it exists: claude / codex both render through Ink, which wraps prose to the terminal width
 * *itself*, so every visual line carries a real newline plus an indent prefix. xterm's selection
 * handles soft wrapping correctly, which means every newline a copy brings back is one the
 * application really emitted — there is no fix on the terminal side. The only unwrapped prose
 * lives in the agent's own transcript file, which is what this page reads.
 *
 * Settled shape (do not relitigate): expand in 200–260ms ease-out with a faster collapse; the
 * surface follows the theme, one step lighter than the terminal and **never pure white**; the
 * person's turns get a bubble and the agent's prose does not, so the alternation reads without
 * dividers.
 *
 * Markdown is **rendered**, which reverses this plan's original decision to show the source
 * verbatim. That decision bought byte-exact copy; the user chose readability instead, and the
 * problem that started all of this — hard newlines and indent prefixes — is solved either way.
 */

/** 展开/收起时长：这动画一天要看几十次，过 300ms 就从惊喜变成等待。 */
const EXPAND_MS = 230;
const COLLAPSE_MS = 160;
/** 收拢态的半径：刚好罩住按钮，于是纸面看起来是从按钮里长出来的。 */
const SEED_RADIUS = 16;

type TerminalPaperProps = {
  /** 内置 agent 名（claude / codex）。 */
  agent: string;
  /** agent 自己的会话标识；调用方已确认可用。 */
  agentSessionId: string;
  workspaceId: string;
  /** 直接就是 `client.execInWorkspace`：它本身就按工作区归属路由，本地远程同一条路。 */
  exec: TranscriptExec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ⌘F 查找框占着同一个角（right-4 top-2）：它开着时按钮让位。 */
  buttonHidden: boolean;
  /** 收起之后把焦点还给终端。 */
  onRestoreFocus: () => void;
  /**
   * Whether this paper's terminal is the focused one (plan 20260923-terminal-split-groups). Several
   * panes can be on screen, each with its paper open; only the focused one answers Esc, or one Esc
   * would close them all. Defaults to true.
   */
  escapeEnabled?: boolean;
};

export function TerminalPaper(props: TerminalPaperProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const execRef = useRef(props.exec);

  // mounted 与 open 刻意分开：收起动画跑完之前纸面还得留在 DOM 里。
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [circle, setCircle] = useState({ x: 0, y: 0, radius: 0 });
  const [result, setResult] = useState<TranscriptResult | null>(null);

  /** 圆心取按钮中心，半径取到四角的最远距离——于是纸面正好在盖满的那一刻停住。 */
  const measure = useCallback(() => {
    const layer = layerRef.current;
    const button = buttonRef.current;
    if (!layer || !button) return;
    const box = layer.getBoundingClientRect();
    const dot = button.getBoundingClientRect();
    const x = dot.left + dot.width / 2 - box.left;
    const y = dot.top + dot.height / 2 - box.top;
    setCircle({
      x,
      y,
      radius: Math.max(
        Math.hypot(x, y),
        Math.hypot(box.width - x, y),
        Math.hypot(x, box.height - y),
        Math.hypot(box.width - x, box.height - y),
      ),
    });
  }, []);

  // 挂上之后先量一次再放大：首帧必须是收拢态，否则看不到"从按钮里长出来"。
  // 依赖里带 open 是为了"收起动画还没跑完又点开"——那时 mounted 一直是 true，
  // 只看 mounted 的话 expanded 永远回不到 true，纸面就卡在收拢态了。
  useLayoutEffect(() => {
    if (!mounted || !props.open) return;
    measure();
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, props.open, measure]);

  // 窗口尺寸变了，最远角也就变了；不重算的话四角会露出终端。
  useEffect(() => {
    if (!mounted) return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mounted, measure]);

  useEffect(() => {
    if (props.open) setMounted(true);
    else setExpanded(false);
  }, [props.open]);

  useEffect(() => {
    execRef.current = props.exec;
  }, [props.exec]);

  // 收起动画跑完才卸载并清掉快照——下次打开重新取一次，不做实时跟随。
  const onRestoreFocus = props.onRestoreFocus;
  useEffect(() => {
    if (props.open || !mounted || expanded) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setResult(null);
      onRestoreFocus();
    }, COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [props.open, mounted, expanded, onRestoreFocus]);

  // 打开即取一次快照。
  const { agent, agentSessionId, workspaceId } = props;
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setResult(null);
    void loadTranscript(execRef.current, { agent, agentSessionId, workspaceId }).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mounted, agent, agentSessionId, workspaceId]);

  // 落在最新的一条上（记录文件是时间正序，最新在末尾）。
  useLayoutEffect(() => {
    if (!mounted || result === null) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [mounted, result]);

  const onOpenChange = props.onOpenChange;
  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  /**
   * Esc 走 window 的 capture 阶段。这一条不是洁癖：Esc 不是 ⌘ 组合键，终端的按键归属判定会把它
   * 判给终端并原样写进 PTY（terminal-pane.tsx 的 decideTerminalKeyOwner），而一个到得了
   * Claude Code 的 Esc 会打断它正在进行的回合——比纸面关不掉严重得多。焦点本来就在纸面上，
   * 这里是第二道保险。
   */
  const escapeEnabled = props.escapeEnabled ?? true;
  useEffect(() => {
    if (!mounted || !escapeEnabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [mounted, escapeEnabled, requestClose]);

  // 纸面自己收下焦点，终端那侧连 keydown 都收不到。
  useEffect(() => {
    if (!mounted) return;
    scrollRef.current?.focus({ preventScroll: true });
  }, [mounted]);

  function toggle() {
    if (props.open) {
      requestClose();
      return;
    }
    // 先量后开：首帧就得拿到正确的圆心，否则第一次展开会从左上角冒出来。
    measure();
    onOpenChange(true);
  }

  const showButton = props.open || !props.buttonHidden;

  return (
    // 整层不吃鼠标事件，按钮与纸面各自收回来；本层不设 z-index，于是子元素的层级与查找框
    // （z-20）、链接提示（z-30）在同一个层叠上下文里比较。
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {mounted ? (
        <div
          className="pointer-events-auto absolute inset-0 z-40 overflow-hidden bg-popover"
          style={{
            clipPath: `circle(${expanded ? circle.radius : SEED_RADIUS}px at ${circle.x}px ${circle.y}px)`,
            transitionProperty: "clip-path",
            transitionDuration: `${expanded ? EXPAND_MS : COLLAPSE_MS}ms`,
            // 展开快起慢收（ease-out），收起换一条更利落的曲线并快一档。
            transitionTimingFunction: expanded ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
          }}
        >
          <div
            ref={scrollRef}
            tabIndex={-1}
            aria-label="对话原文"
            className="h-full w-full cursor-text select-text overflow-y-auto outline-none"
          >
            {/* One centred column in the system UI face: together with the terminal's monospace, that
                pairing — not a glaring white sheet — is what makes this read as paper (the surface
                follows the theme). The measure is Cursor's `--composer-max-width`, a constant 840px at
                every window size: a pane narrower than it simply fills, and a 3840px display does not
                stretch prose into hundred-character lines. 15px on a 24px line is Cursor's
                `--cursor-font-size-lg` / `--cursor-line-height-lg`; `text-lg` is already that step here
                (index.css, IDE density — `text-base` is 13px, which is how a `ch` measure once came out
                at 490px). break-words catches tokens with no break opportunity (URLs, hashes) so they
                wrap instead of widening the column. */}
            <div className="mx-auto max-w-[840px] break-words px-8 pb-16 pt-6 font-sans text-lg leading-[1.6]">
              <PaperHeader agent={props.agent} />
              <PaperBody result={result} />
            </div>
          </div>
        </div>
      ) : null}
      {showButton ? (
        <Tooltip content={props.open ? "关闭" : "对话原文"}>
          <button
            ref={buttonRef}
            // z-50：压在纸面（z-40）之上，于是"再点一次按钮收起"成立——按钮始终在原地。
            className="pointer-events-auto absolute right-4 top-2 z-50 flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            aria-label={props.open ? "关闭对话原文" : "查看对话原文"}
            aria-expanded={props.open}
            onClick={toggle}
          >
            {props.open ? <X className="size-3.5" /> : <ScrollText className="size-3.5" />}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** 贴在顶上：页面开局落在最新一条，不粘住的话这行提示一上来就在视野外。
 *  select-none 是为了整页框选时它不会混进复制出来的正文。 */
function PaperHeader({ agent }: { agent: string }) {
  return (
    <div className="sticky top-0 z-10 mb-6 flex select-none items-baseline gap-2 border-b border-border bg-popover pb-3 pr-10 pt-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">对话原文</span>
      <span>{agent}</span>
      <span className="ml-auto">Esc 关闭</span>
    </div>
  );
}

function PaperBody({ result }: { result: TranscriptResult | null }) {
  if (result === null) return <PaperNote title="正在加载…" />;
  // Every failure state is written from the reader's chair: what they are looking at and what to
  // do next. Config directories, daemons and exit codes are ours to debug, not theirs to read.
  if (result.status === "not-found") {
    return <PaperNote title="读不到这个会话的内容" detail="agent 可能刚启动，等它回复一次再看" />;
  }
  if (result.status === "failed") return <PaperNote title="打不开这个会话" detail={result.detail} />;
  const { entries, truncated } = result.document;
  if (entries.length === 0) {
    return <PaperNote title="还没有对话内容" detail="跟它说点什么，再回来看" />;
  }
  // 块级排版（不是 flex column）：宽内容——代码块、表格——撑不宽版心，只在自己那格里横向滚。
  return (
    <div className="space-y-5">
      {truncated ? <p className="text-xs text-muted-foreground">只显示了最近的部分</p> : null}
      {entries.map((entry, index) => (
        <PaperEntry key={index} entry={entry} />
      ))}
    </div>
  );
}

function PaperEntry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "tool") {
    // A tool call is only a landmark: one line, dim, never expanded. It sits one step under the
    // prose (12px against 15px) so it signposts without competing — and keeps the monospace face,
    // because these lines carry shell commands.
    return <p className="truncate font-mono text-sm text-muted-foreground">⏺ {entry.label}</p>;
  }
  if (entry.kind === "prompt") {
    // Only the person's own turns get a bubble: those are the anchors you scan for on the way
    // back up. The extra top padding does the work a divider would.
    //
    // The skin is Cursor's `.composer-human-message`: a 1px stroke, the input surface as fill, a
    // 12px radius. Two of those three have to be spelled out rather than taken from a token.
    // `border-border` (#242422 on a #1b1b1a paper) is a ~3% step and reads as no outline at all,
    // where Cursor's stroke is ~12% of the foreground — hence the foreground mix. And `rounded-xl`
    // is not 12px here: Astryx maps it to `--radius-page`, 28px.
    return (
      <div className="flex justify-end pt-2">
        <div className="min-w-0 max-w-[80%] rounded-[12px] border border-foreground/12 bg-input px-3 py-2 text-foreground">
          <PaperMarkdown text={entry.text} />
        </div>
      </div>
    );
  }
  // 正文是页面的主体，不装框：它读起来该像文档，不像聊天记录。
  return (
    <div className="text-foreground/90">
      <PaperMarkdown text={entry.text} />
    </div>
  );
}

function PaperNote({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="space-y-2 py-6">
      <p className="text-sm text-foreground">{title}</p>
      {detail ? <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/**
 * `remark-gfm` because agents write GFM, not bare CommonMark: tables, strikethrough and task
 * lists are routine in their answers. `remark-breaks` because a single newline is a line the
 * author meant — neither a model nor a person typing into a terminal hard-wraps to a column, so
 * CommonMark's "fold soft breaks into spaces" would run their lines together.
 *
 * Deliberately absent: `rehype-raw`. Everything on this page is agent output, which includes
 * whatever a person pasted at it, so raw HTML must stay inert. react-markdown's default turns an
 * html node into a *text* node — the tags show up as the characters they are — and nothing here
 * hands transcript content to `dangerouslySetInnerHTML`.
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Fenced blocks and inline spans both arrive as a hast `code` element; the `pre` wrapper is the
 * only thing that tells them apart, so it announces itself to whatever it wraps.
 */
const InsideCodeBlock = createContext(false);

function MarkdownPre({ children }: { children?: ReactNode }) {
  return (
    <InsideCodeBlock value={true}>
      {/* 横向滚动而不是撑宽：版心宽度是这页可读性的全部，长命令行不该改变它。 */}
      <pre className="mb-[1em] overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-base leading-[1.4] last:mb-0">
        {children}
      </pre>
    </InsideCodeBlock>
  );
}

function MarkdownCode({ children, className }: { children?: ReactNode; className?: string }) {
  const insideBlock = useContext(InsideCodeBlock);
  // 块内的 code 不再自己上底色：外面那层 pre 已经是块了，再叠一层会糊成两个方框。
  if (insideBlock) return <code className={className}>{children}</code>;
  return <code className="rounded-sm bg-accent px-1 py-0.5 font-mono text-sm">{children}</code>;
}

function MarkdownLink({ children, href }: { children?: ReactNode; href?: string }) {
  return (
    <a
      href={href}
      className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      onClick={(event) => {
        // 与终端里的链接同一条路（plan 109）：带 URL 调 window.open，主进程一律 deny 并把真实
        // URL 交 shell.openExternal。渲染层自己绝不导航——那会把整个工作台冲掉。
        event.preventDefault();
        if (href) window.open(href, "_blank", "noopener");
      }}
    >
      {children}
    </a>
  );
}

/**
 * Images are never fetched. The source of this page is agent output, so a remote `<img>` would
 * make opening it a network callback to whoever wrote the URL. The alt text and the link are all
 * a reader needs anyway.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const label = alt && alt.length > 0 ? alt : (src ?? "image");
  return <MarkdownLink href={src}>{label}</MarkdownLink>;
}

/**
 * Block spacing is Cursor's one-sided rule — `margin-top: 0`, `margin-bottom: 1em` — and not a
 * symmetric rhythm: symmetric margins collapse differently between siblings and nested blocks, so
 * the same markup gains and loses gaps depending on what it happens to sit next to. Headings are
 * the one exception and keep symmetric `.5em` margins, which is why they alone still carry
 * `first:mt-0`; everywhere else the top margin is already zero.
 *
 * `last:mb-0` stays on every block, and still earns its keep: a single paragraph inside a list
 * item or a table cell is both first and last, so a loose list stops looking like a set of
 * separate paragraphs without a rule of its own.
 */
const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownPre,
  code: MarkdownCode,
  // The tag demotion stays (this page's own title is in the header bar, so a message's `#` is a
  // section break, not a page title). Only the top two levels grow, to Cursor's 1.214em of the
  // 15px body — 18px, which is the `--coflux-text-2xl` step. From there down a heading sits at
  // body size and its weight alone separates it, exactly as the reference does.
  h1: ({ children }) => <h2 className="my-[0.5em] text-2xl font-semibold text-foreground first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="my-[0.5em] text-2xl font-semibold text-foreground first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="my-[0.5em] text-lg font-medium text-foreground first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="my-[0.5em] text-lg font-medium text-foreground first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="my-[0.5em] text-lg font-medium text-foreground first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="my-[0.5em] text-lg font-medium text-foreground first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="mb-[1em] last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-[1em] list-disc space-y-1 pl-[2em] marker:text-muted-foreground last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-[1em] list-decimal space-y-1 pl-[2em] marker:text-muted-foreground last:mb-0">{children}</ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-[1em] border-l-[3px] border-border pl-[1em] text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="mb-[1em] border-border last:mb-0" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  table: ({ children }) => (
    <div className="mb-[1em] overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border p-[0.5em] text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border p-[0.5em] align-top">{children}</td>,
};

function PaperMarkdown({ text }: { text: string }) {
  return (
    <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>
      {text}
    </Markdown>
  );
}
