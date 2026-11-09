import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ArrowUp, Mic } from "lucide-react";

import { cn } from "@/lib/utils";
import { desktop } from "@/config";
import { wordEmphasis } from "./changes-word-diff";
import type { DictationController, DictationLevel } from "./use-dictation";

/**
 * The pane's dictation surfaces (plan 20261110-desktop-dictation): a round button 16 px from the
 * pane's right and bottom edges, and a text bubble above it anchored bottom-right. The bubble shows
 * only the text — no status, engine name or key hint — growing one character at a time while the
 * recogniser speaks, then editable in place with 原文 / 整理后 and a send button.
 */

/** Button 34 px + 16 px margin; the bubble sits 8 px above the button. */
export const DICTATION_BUTTON_SIZE = 34;
/** What the pane's bottom-right corner must leave free above its regular 16 px margin. */
export const DICTATION_CLEARANCE_PX = DICTATION_BUTTON_SIZE + 8;
/** The bubble's text column grows to this width, then wraps. */
const BUBBLE_MAX_TEXT_WIDTH = 420;
/** Character reveal pacing (ms per character): calm, faster with a backlog. */
const REVEAL_MS = 34;
const REVEAL_FAST_MS = 16;
const REVEAL_RUSH_MS = 6;
/** How long a corrected word stays highlighted. */
const FLASH_MS = 1400;

const reducedMotionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery?.matches ?? false);
  useEffect(() => {
    if (!reducedMotionQuery) return;
    const onChange = () => setReduced(reducedMotionQuery.matches);
    reducedMotionQuery.addEventListener("change", onChange);
    return () => reducedMotionQuery.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

/** Writes the level onto the element as `--dictation-level` (0…1), outside React's render. */
function useLevelVariable(level: DictationLevel, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const write = (value: number) => ref.current?.style.setProperty("--dictation-level", value.toFixed(3));
    write(level.get());
    return level.subscribe(write);
  }, [level, ref]);
}

// ---------------------------------------------------------------------------- button

export function DictationButton({ dictation }: { dictation: DictationController }) {
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLevelVariable(dictation.level, rootRef);
  const { phase } = dictation;
  const busy = phase === "connecting" || phase === "finishing" || phase === "correcting";
  const listening = phase === "listening";
  const label = listening ? "停止语音输入" : "语音输入";
  return (
    <div ref={rootRef} className="pointer-events-auto absolute bottom-4 right-4 z-40 size-[34px]">
      {listening && !reduced ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-destructive/15 transition-transform duration-100 ease-out"
            style={{ transform: "scale(calc(1.15 + var(--dictation-level, 0) * 0.75))" }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-destructive/25 transition-transform duration-75 ease-out"
            style={{ transform: "scale(calc(1.05 + var(--dictation-level, 0) * 0.35))" }}
          />
        </>
      ) : null}
      <Tooltip content="语音输入 ⌥Space" placement="above">
        <button
          type="button"
          aria-label={label}
          aria-pressed={listening}
          disabled={busy}
          // The terminal keeps the keyboard: Esc and ⌥Space must still reach it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={dictation.toggle}
          className={cn(
            "relative flex size-full items-center justify-center rounded-full border transition-colors duration-150",
            listening
              ? "border-transparent bg-destructive text-destructive-foreground"
              : busy
                ? "border-border bg-background/90 text-muted-foreground"
                : "border-border bg-background/80 text-muted-foreground/60 shadow-sm hover:bg-accent hover:text-foreground group-hover/pane:text-muted-foreground",
          )}
        >
          {busy ? <LoadingBars reduced={reduced} /> : listening ? <LevelMic reduced={reduced} /> : <Mic className="size-4" />}
        </button>
      </Tooltip>
    </div>
  );
}

/** Four bars rising in a wave left to right, each brightening at its crest. */
function LoadingBars({ reduced }: { reduced: boolean }) {
  const barsRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const bars = barsRef.current ? Array.from(barsRef.current.children) : [];
    if (reduced) return;
    const animations = bars.map((bar, index) =>
      bar.animate(
        [
          { transform: "scaleY(0.4)", opacity: 0.45 },
          { transform: "scaleY(1)", opacity: 1, offset: 0.35 },
          { transform: "scaleY(0.4)", opacity: 0.45, offset: 0.7 },
          { transform: "scaleY(0.4)", opacity: 0.45 },
        ],
        { duration: 1100, delay: index * 130, iterations: Infinity, easing: "ease-in-out" },
      ),
    );
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [reduced]);
  return (
    <span ref={barsRef} aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {[0, 1, 2, 3].map((index) => (
        <span key={index} className="h-full w-[2px] origin-center rounded-full bg-current" style={reduced ? { transform: "scaleY(0.7)" } : undefined} />
      ))}
    </span>
  );
}

/** lucide's Mic, its capsule filling bottom-up with the level; the icon swells slightly with it. */
function LevelMic({ reduced }: { reduced: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4 transition-transform duration-75"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={reduced ? undefined : { transform: "scale(calc(1 + var(--dictation-level, 0) * 0.14))" }}
    >
      <defs>
        <clipPath id="coflux-dictation-capsule">
          <rect x="9" y="2" width="6" height="13" rx="3" />
        </clipPath>
      </defs>
      <rect
        x="9"
        y="2"
        width="6"
        height="13"
        fill="currentColor"
        stroke="none"
        clipPath="url(#coflux-dictation-capsule)"
        style={{ transformBox: "fill-box", transformOrigin: "bottom", transform: "scaleY(var(--dictation-level, 0))" }}
      />
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

// ---------------------------------------------------------------------------- bubble

/** Grows one character at a time; a rewrite keeps the common prefix and re-types the rest. */
function RevealText({ text, reduced }: { text: string; reduced: boolean }) {
  const chars = graphemes(text);
  const [shown, setShown] = useState(reduced ? chars.length : 0);
  // The recogniser rewrote part of what is already on screen: keep the common prefix, re-type the
  // rest. Adjusted during render when the text changes.
  const [previousText, setPreviousText] = useState(text);
  if (text !== previousText) {
    const displayed = graphemes(previousText).slice(0, shown);
    let common = 0;
    while (common < displayed.length && common < chars.length && displayed[common] === chars[common]) common += 1;
    setPreviousText(text);
    if (common < displayed.length) setShown(common);
    else if (shown > chars.length) setShown(chars.length);
  }
  const visible = reduced ? chars.length : Math.min(shown, chars.length);

  useEffect(() => {
    if (reduced || visible >= chars.length) return;
    const backlog = chars.length - visible;
    const delay = backlog > 24 ? REVEAL_RUSH_MS : backlog > 8 ? REVEAL_FAST_MS : REVEAL_MS;
    const timer = window.setTimeout(() => setShown(visible + 1), delay);
    return () => window.clearTimeout(timer);
  });

  return (
    <>
      {chars.slice(0, visible).map((char, index) => (
        <span key={`${index}:${char}`} ref={reduced ? undefined : animateCharIn}>
          {char}
        </span>
      ))}
    </>
  );
}

/** Fades and un-blurs a character the first time it is attached. Stable, so React calls it once. */
function animateCharIn(element: HTMLSpanElement | null): void {
  if (!element || element.dataset.revealed) return;
  element.dataset.revealed = "1";
  element.animate(
    [
      { opacity: 0, filter: "blur(4px)" },
      { opacity: 1, filter: "blur(0px)" },
    ],
    { duration: 220, easing: "ease-out" },
  );
}

/** Corrected words, as ranges of the corrected text; everything when the pair is too different. */
function changedRanges(raw: string, refined: string): { start: number; end: number }[] {
  if (raw === refined) return [];
  const emphasis = wordEmphasis(raw, refined, "show");
  return emphasis ? emphasis.new : [{ start: 0, end: refined.length }];
}

/** Fills the editable element with `text`, wrapping the corrected ranges in flashing spans. */
function fillEditor(element: HTMLElement, text: string, ranges: readonly { start: number; end: number }[], reduced: boolean): void {
  element.replaceChildren();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) element.append(text.slice(cursor, range.start));
    const mark = document.createElement("span");
    mark.textContent = text.slice(range.start, range.end);
    element.append(mark);
    if (!reduced) {
      mark.animate(
        [
          { backgroundColor: "color-mix(in oklab, var(--warning) 45%, transparent)", borderRadius: "3px" },
          { backgroundColor: "transparent", borderRadius: "3px" },
        ],
        { duration: FLASH_MS, easing: "ease-out" },
      );
    }
    cursor = range.end;
  }
  if (cursor < text.length) element.append(text.slice(cursor));
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function DictationBubble({ dictation, editorRef }: { dictation: DictationController; editorRef: RefObject<HTMLDivElement | null> }) {
  const reduced = usePrefersReducedMotion();
  const { phase, text, confirm, error } = dictation;
  const recording = phase === "listening" || phase === "finishing" || phase === "correcting" || phase === "connecting";
  const showText = recording && text.trim().length > 0;
  const shown = showText || phase === "confirm" || phase === "error";

  // The box animates its size to the content: the content is measured (the observer reports its
  // first size before paint), the box follows. A hidden bubble forgets its size.
  // The text column also stays inside a narrow pane (16 px from its left edge).
  const boxRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [maxWidth, setMaxWidth] = useState(BUBBLE_MAX_TEXT_WIDTH + 32);
  if (!shown && size !== null) setSize(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const pane = boxRef.current?.offsetParent;
    if (!shown || !content) return;
    const observer = new ResizeObserver(() => {
      // The box's 1 px border on each side surrounds the content.
      setSize({ width: content.offsetWidth + 2, height: content.offsetHeight + 2 });
      if (pane instanceof HTMLElement) setMaxWidth(Math.max(160, Math.min(BUBBLE_MAX_TEXT_WIDTH + 32, pane.clientWidth - 34)));
    });
    observer.observe(content);
    if (pane instanceof HTMLElement) observer.observe(pane);
    return () => observer.disconnect();
  }, [shown]);

  // Confirm: the editable text is filled imperatively (React does not own its children), takes the
  // keyboard, and flashes the corrected words. Only the confirm entry and the 原文 / 整理后 switch
  // refill it; edits in between are the user's.
  const fillKey = phase === "confirm" && confirm ? `${confirm.raw}\u0000${confirm.refined ?? ""}\u0000${confirm.showingOriginal}` : null;
  const fill = useEffectEvent(() => {
    const editor = editorRef.current;
    if (!confirm || !editor) return;
    const ranges = !confirm.showingOriginal && confirm.refined !== null ? changedRanges(confirm.raw, confirm.refined) : [];
    fillEditor(editor, dictation.draft(), ranges, reduced);
    editor.focus();
    placeCaretAtEnd(editor);
  });
  useLayoutEffect(() => {
    if (fillKey !== null) fill();
  }, [fillKey]);

  if (!shown) return null;
  const distinct = confirm !== null && confirm.refined !== null && confirm.refined !== confirm.raw;

  return (
    <div
      ref={boxRef}
      className={cn(
        "pointer-events-auto absolute bottom-[58px] right-4 z-40 overflow-hidden rounded-3xl border border-border bg-popover/95 text-base text-popover-foreground shadow-lg backdrop-blur [corner-shape:squircle]",
        reduced ? "" : "transition-[width,height] duration-200 ease-out",
      )}
      style={size ? { width: size.width, height: size.height } : { visibility: "hidden" }}
    >
      <div ref={contentRef} className="absolute bottom-0 right-0 w-max px-4 py-2.5" style={{ maxWidth }}>
        {phase === "error" && error ? (
          <ErrorLine error={error} onAction={dictation.cancel} />
        ) : phase === "confirm" && confirm ? (
          <div className="flex flex-col gap-2">
            <div
              ref={editorRef}
              role="textbox"
              aria-multiline
              aria-label="识别的文字"
              contentEditable="plaintext-only"
              suppressContentEditableWarning
              spellCheck={false}
              className="min-w-8 whitespace-pre-wrap break-words leading-relaxed outline-none"
              onInput={(event) => dictation.setDraft(event.currentTarget.innerText)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  dictation.cancel();
                } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
                  event.preventDefault();
                  if (event.metaKey) dictation.insert();
                  else dictation.send();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              {distinct ? (
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={dictation.toggleOriginal}
                >
                  {confirm.showingOriginal ? "整理后" : "原文"}
                </button>
              ) : null}
              <Tooltip content="发送" placement="above">
                <button
                  type="button"
                  aria-label="发送"
                  disabled={!dictation.canDeliver}
                  className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-35"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={dictation.send}
                >
                  <ArrowUp className="size-4" />
                </button>
              </Tooltip>
            </div>
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words leading-relaxed" aria-live="polite">
            <RevealText text={text} reduced={reduced} />
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorLine({ error, onAction }: { error: "unreachable" | "invalid_key" | "microphone"; onAction: () => void }) {
  if (error === "unreachable") return <div className="whitespace-nowrap text-muted-foreground">连接失败</div>;
  const message = error === "microphone" ? "需要麦克风权限" : "语音识别 API Key 无效";
  const action = error === "microphone" ? "打开系统设置" : "去设置";
  return (
    <div className="flex items-center gap-3 whitespace-nowrap">
      <span>{message}</span>
      <button
        type="button"
        className="rounded-md px-1.5 py-0.5 text-sm text-foreground underline-offset-2 transition-colors hover:bg-accent"
        onClick={() => {
          if (error === "microphone") desktop.openMicrophoneSettings();
          else desktop.openSettings();
          onAction();
        }}
      >
        {action}
      </button>
    </div>
  );
}
