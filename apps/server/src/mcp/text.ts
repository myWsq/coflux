/**
 * 终端快照 → agent 可读纯文本（plan 090 `read_terminal`）。与 packages/cli/cofluxd.mjs 的
 * stripAnsi/tailLines 同构（CLI 侧不可直接 import，故复制一份）：checkpoint 本身语义不动
 * （它同时是 web 的数据源），去 ANSI 只在这一层做。
 */

// OSC（ESC ] … BEL / ESC ] … ST）、CSI/ESC 序列、以及除 \t \n \r 之外的 C0 控制字符与 DEL。
const ANSI_RE =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]|[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 取最后 n 行并去掉尾部空行——VT snapshot 的下半屏通常是成片空行，对 agent 是纯噪音。 */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-n).join("\n");
}
