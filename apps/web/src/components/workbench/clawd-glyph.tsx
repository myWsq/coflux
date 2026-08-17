import { useLayoutEffect, useRef } from "react";

import gymSvg from "@/assets/clawd/gym.svg?raw";
import confettiSvg from "@/assets/clawd/confetti.svg?raw";
import flagSvg from "@/assets/clawd/flag.svg?raw";
import { cn } from "@/lib/utils";

/** Tab 上 Clawd 的三个姿态，对应用户当初拖进来的三份原站精灵图。 */
export type ClawdPose = "active" | "raise" | "rest";

// 素材来自 ayotomcs.me/claude-mascot（用户 2026-08-17 拖入）。原站用 GSAP 切
// display；这里按 Codrops 文里的时序用 setTimeout 重放，不引入 GSAP。
// 品牌橙固定为 #D97757（用户 2026-08-15 指定），不走主题 token。
const SVG: Record<ClawdPose, string> = {
  active: prepare(gymSvg),
  raise: prepare(flagSvg),
  rest: prepare(confettiSvg),
};

// 36 帧插画，13–24 再播一遍当第二组，共 48 拍。
const GYM_SEQUENCE: number[] = [
  ...range(0, 13),
  ...range(13, 25),
  ...range(13, 25),
  ...range(25, 36),
];

const CONFETTI_FRAME_MS = 125;
const CONFETTI_Y = [-65, -72, -76, -70, -58, -42, -22, 0];

const FLAG_FRAME_MS = 100;
const FLAG_HAND_X = [0, -6, -12, -14, -8, -2, 0, 0, -4, -10, -16, -18];
const FLAG_SWAY_X = [0, 0, -5, -5, 0, 4, 4, 4, 0, 0, -5, -5];
const FLAG_LEFT_HAND_Y = [0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 4, 4];

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

function prepare(raw: string): string {
  return raw
    .replace(/#DD775B/gi, "#D97757")
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\sid="[^"]*"/g, "")
    .replace(/\sdata-svg-origin="[^"]*"/g, "");
}

function kids(parent: Element, tag: string): Element[] {
  return [...parent.children].filter((el) => el.tagName === tag);
}

function showOnly(els: Element[], index: number) {
  for (let i = 0; i < els.length; i++) {
    (els[i] as SVGElement).style.display = i === index ? "inline" : "none";
  }
}

function gymDelay(seqIdx: number, frame: number): number {
  if (seqIdx === GYM_SEQUENCE.length - 1) return 1500;
  if (frame === 6 || frame === 7) return 270;
  if (frame === 15 || frame === 21) return 400;
  return 85;
}

function playGym(svg: SVGSVGElement): () => void {
  const frames = kids(svg, "g");
  let seqIdx = 0;
  let timer = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const frame = GYM_SEQUENCE[seqIdx];
    showOnly(frames, frame);
    const delay = gymDelay(seqIdx, frame);
    seqIdx = (seqIdx + 1) % GYM_SEQUENCE.length;
    timer = window.setTimeout(tick, delay);
  };
  tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

function playConfetti(svg: SVGSVGElement): () => void {
  const groups = kids(svg, "g");
  const chars = groups.slice(0, 8);
  const burst1 = groups[8];
  const burst2 = groups[9];
  const particles1 = kids(burst1, "g");
  const particles2 = kids(burst2, "g");
  let i = 0;
  let timer = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    showOnly(chars, i % 8);
    const b1 = i - 1;
    const b2 = i - 6;
    if (b1 >= 0) {
      const f = b1 % 8;
      burst1.setAttribute("style", "display: inline");
      burst1.setAttribute("transform", `translate(90, ${-22 + CONFETTI_Y[f]})`);
      showOnly(particles1, f);
    } else {
      burst1.setAttribute("style", "display: none");
    }
    if (b2 >= 0) {
      const f = b2 % 8;
      burst2.setAttribute("style", "display: inline");
      burst2.setAttribute("transform", `translate(40, ${-72 + CONFETTI_Y[f]}) scale(-1, 1)`);
      showOnly(particles2, f);
    } else {
      burst2.setAttribute("style", "display: none");
    }
    i += 1;
    timer = window.setTimeout(tick, CONFETTI_FRAME_MS);
  };
  tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

function playFlag(svg: SVGSVGElement): () => void {
  const body = kids(svg, "g")[0] as SVGGElement;
  const leftHand = body.children[5] as SVGElement;
  const handGroup = body.children[8] as SVGGElement;
  const flagFrames = kids(handGroup, "g");
  body.removeAttribute("transform");
  body.style.transform = "";
  handGroup.removeAttribute("transform");
  handGroup.style.transform = "";
  let frame = 0;
  let pastIntro = false;
  let timer = 0;
  let stopped = false;
  const apply = (n: number) => {
    body.setAttribute("transform", `translate(${FLAG_SWAY_X[n]}, 0)`);
    handGroup.setAttribute("transform", `translate(${FLAG_HAND_X[n]}, 0)`);
    leftHand.setAttribute("transform", `translate(0, ${FLAG_LEFT_HAND_Y[n]})`);
    showOnly(flagFrames, n);
  };
  const tick = () => {
    if (stopped) return;
    apply(frame);
    if (!pastIntro) {
      if (frame < 11) frame += 1;
      else {
        pastIntro = true;
        frame = 3;
      }
    } else {
      frame = frame === 11 ? 3 : frame + 1;
    }
    timer = window.setTimeout(tick, FLAG_FRAME_MS);
  };
  tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

function freeze(svg: SVGSVGElement, pose: ClawdPose) {
  if (pose === "active") {
    showOnly(kids(svg, "g"), 32);
    return;
  }
  if (pose === "rest") {
    const groups = kids(svg, "g");
    showOnly(groups.slice(0, 8), 0);
    groups[8]?.setAttribute("style", "display: none");
    groups[9]?.setAttribute("style", "display: none");
    return;
  }
  const body = kids(svg, "g")[0];
  const handGroup = body.children[8] as SVGGElement;
  showOnly(kids(handGroup, "g"), 5);
}

function play(svg: SVGSVGElement, pose: ClawdPose): () => void {
  if (pose === "active") return playGym(svg);
  if (pose === "rest") return playConfetti(svg);
  return playFlag(svg);
}

/** 终端 Tab 上的 Clawd：每个姿态播自己那套原站逐帧，而不是整图标 hop。 */
export function ClawdGlyph({ pose, className }: { pose: ClawdPose; className?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = SVG[pose];
    const svg = host.querySelector("svg");
    if (!svg) return;
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.style.display = "block";
    svg.style.overflow = "visible";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      freeze(svg, pose);
      return;
    }
    return play(svg, pose);
  }, [pose]);

  return <span ref={hostRef} className={cn("inline-flex size-4 shrink-0 overflow-visible", className)} aria-hidden />;
}
