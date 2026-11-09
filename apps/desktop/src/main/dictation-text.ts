/**
 * Token estimates for dictation context budgets, ported from the iOS `DictationTranscript`
 * (apps/ios/Coflux/Speech/DictationContext.swift). The renderer's dictation-context.ts carries the
 * same functions for the recognition context; both copies follow the Swift code.
 */

/** Token budget for all recognition items together (seed-asr D3). */
export const RECOGNITION_TOKEN_BUDGET = 1500;

function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

/** CJK characters ≈ 1 token each; other text ≈ 4 characters per token (counted in Unicode scalars). */
export function estimatedTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCJK(char.codePointAt(0)!)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor((other + 3) / 4);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text split into user-perceived characters (Swift `Character`s). */
export function characters(text: string): string[] {
  return Array.from(graphemes.segment(text), (segment) => segment.segment);
}

/** Swift `String.count`: the number of grapheme clusters. */
export function characterCount(text: string): number {
  let count = 0;
  for (const _ of graphemes.segment(text)) count += 1;
  return count;
}

/** The longest end of `text` within `budget` estimated tokens, trimmed. */
export function suffixWithin(text: string, budget: number): string {
  if (budget <= 0) return "";
  const chars = characters(text);
  let cjk = 0;
  let other = 0;
  let start = chars.length;
  while (start > 0) {
    for (const scalar of chars[start - 1]!) {
      if (isCJK(scalar.codePointAt(0)!)) cjk += 1;
      else other += 1;
    }
    if (cjk + Math.floor((other + 3) / 4) > budget) break;
    start -= 1;
  }
  return chars.slice(start).join("").trim();
}
