/**
 * URL detection for the terminal's own web-link provider (plan 20261001-terminal-file-tab).
 *
 * The terminal used `@xterm/addon-web-links`, but its links carry no `decorations`, and xterm then
 * always underlines on hover; the hover style is now a colour, so the provider is written here.
 * Where a URL ends follows VS Code's `LinkComputer` (`src/vs/editor/common/languages/linkComputer.ts`,
 * MIT, © Microsoft Corporation): the addon's regex stops only at ASCII characters, so a URL ran on
 * into the Chinese punctuation after it (`https://cchost.ai/docs，然后登录` was one link). The
 * `new URL` sanity check and walking wrapped lines both ways are re-implemented below after
 * `@xterm/addon-web-links` 0.13 (`src/WebLinkProvider.ts`, MIT, © The xterm.js authors).
 */

import type { IBuffer, IBufferRange } from "@xterm/xterm";

/** Where a URL starts. Same schemes as the addon's default pattern. */
const URL_SCHEME = /(?:https?|HTTPS?):\/\//g;

/**
 * Characters that end a URL wherever they appear: the unsafe ASCII ones, and the CJK punctuation
 * and brackets that follow a URL in Chinese or Japanese text without a space. CJK letters are not
 * here — a path like `/wiki/中文` is a real URL, so letters stay part of it.
 */
const URL_TERMINATORS = new Set([..."\"'!*|\\^<>`", ..."、。｡､，．：；‘’〈〉「」『』〔〕（）［］｛｝｢｣｀～…【】"]);

/** ASCII bracket pairs, counted per kind so a closer only belongs to the URL if it closes one. */
const URL_OPENERS: Record<string, number> = { "(": 0, "[": 1, "{": 2 };
const URL_CLOSERS: Record<string, number> = { ")": 0, "]": 1, "}": 2 };

/** Sentence punctuation that is never the URL's last character. */
const URL_TRAILING = new Set([".", ",", ";", ":", "!", "?", "~"]);

export type UrlRange = { start: number; end: number; text: string };

/**
 * Every http(s) URL in `text`, as string offsets (`end` exclusive). A URL runs from its scheme to
 * the first whitespace or terminator; an ASCII closing bracket ends it unless it closes a bracket
 * opened inside the URL (`Foo_(bar)` keeps its parenthesis, `(https://…)` loses the outer one);
 * trailing sentence punctuation is then dropped.
 */
export function findUrlRanges(text: string): UrlRange[] {
  const ranges: UrlRange[] = [];
  const scheme = new RegExp(URL_SCHEME);
  let match: RegExpExecArray | null;
  while ((match = scheme.exec(text))) {
    const start = match.index;
    const schemeEnd = start + match[0].length;
    const depth = [0, 0, 0];
    let end = schemeEnd;
    for (; end < text.length; end++) {
      const char = text[end];
      if (/\s/.test(char) || URL_TERMINATORS.has(char)) break;
      const opener = URL_OPENERS[char];
      if (opener !== undefined) {
        depth[opener]++;
        continue;
      }
      const closer = URL_CLOSERS[char];
      if (closer !== undefined) {
        if (depth[closer] === 0) break;
        depth[closer]--;
      }
    }
    while (end > schemeEnd && URL_TRAILING.has(text[end - 1])) end--;
    if (end > schemeEnd) ranges.push({ start, end, text: text.slice(start, end) });
    scheme.lastIndex = Math.max(end, schemeEnd);
  }
  return ranges;
}

/** Lines are joined across soft wraps up to this many characters each way. */
const WRAP_WINDOW = 2048;

export type TerminalWebLink = { range: IBufferRange; text: string };

function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const base =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return text.toLocaleLowerCase().startsWith(base.toLocaleLowerCase());
  } catch {
    return false;
  }
}

/** The wrapped lines around `lineIndex` (0-based) and the index of the first one. */
function windowedLines(buffer: IBuffer, lineIndex: number): [string[], number] {
  const lines: string[] = [];
  let top = lineIndex;
  let line = buffer.getLine(lineIndex);
  if (!line) return [lines, top];
  const current = line.translateToString(true);
  if (line.isWrapped && current[0] !== " ") {
    let length = 0;
    while ((line = buffer.getLine(--top)) && length < WRAP_WINDOW) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.includes(" ")) break;
    }
    lines.reverse();
  }
  lines.push(current);
  let bottom = lineIndex;
  let length = 0;
  while ((line = buffer.getLine(++bottom)) && line.isWrapped && length < WRAP_WINDOW) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.includes(" ")) break;
  }
  return [lines, top];
}

/**
 * Map a string index back to a buffer position, [line, column] 0-based, or [-1, -1] when it runs
 * past the buffer. Lines were read with trimRight, which corrupts the 1:1 mapping for a wide
 * character wrapped early at a line's last cell; that case is corrected as the addon does.
 */
function mapStringIndex(buffer: IBuffer, lineIndex: number, column: number, stringIndex: number): [number, number] {
  const cell = buffer.getNullCell();
  let start = column;
  let remaining = stringIndex;
  let index = lineIndex;
  while (remaining) {
    const line = buffer.getLine(index);
    if (!line) return [-1, -1];
    for (let x = start; x < line.length; x++) {
      line.getCell(x, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        remaining -= chars.length || 1;
        if (x === line.length - 1 && chars === "") {
          const next = buffer.getLine(index + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return [index, x];
    }
    index++;
    start = 0;
  }
  return [index, start];
}

/** Every URL that touches buffer line `y` (1-based, as xterm's link providers receive it). */
export function findTerminalWebLinks(buffer: IBuffer, y: number): TerminalWebLink[] {
  const [lines, top] = windowedLines(buffer, y - 1);
  const joined = lines.join("");
  const links: TerminalWebLink[] = [];
  for (const { start, text } of findUrlRanges(joined)) {
    if (!isUrl(text)) continue;
    const [startY, startX] = mapStringIndex(buffer, top, 0, start);
    if (startY === -1 || startX === -1) continue;
    const [endY, endX] = mapStringIndex(buffer, startY, startX, text.length);
    if (endY === -1 || endX === -1) continue;
    // IBufferRange is 1-based and end-inclusive: +1 on the start, the 0-based exclusive end as is.
    links.push({ range: { start: { x: startX + 1, y: startY + 1 }, end: { x: endX, y: endY + 1 } }, text });
  }
  return links;
}
