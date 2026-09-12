//! `terminal read` 的纯文本化：与 node 版 `stripAnsi` / `tailLines` 逐字对齐（plan 112）。
//!
//! node 版的正则：
//! `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`                                  OSC（BEL 或 ST 收尾）
//! `|\x1b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]`  CSI 及其它 ESC 序列
//! `|[\x00-\x08\x0b-\x1f\x7f]`                                             C0 控制符（留 \t \n）
//! 这里手写等价的扫描器（含第二支的回溯：参数段的末位数字可以充当终止符），不引正则库。

const ESC: char = '\u{1b}';
const BEL: char = '\u{7}';

fn is_c0_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}')
}

fn is_intermediate(c: char) -> bool {
    matches!(c, '[' | ']' | '(' | ')' | '#' | ';' | '?')
}

fn is_final(c: char) -> bool {
    matches!(c, '0'..='9' | 'A'..='P' | 'R'..='T' | 'Z' | 'c' | 'f'..='n' | 't' | 'q' | 'r' | 'y' | '=' | '>' | '<' | '~')
}

/// OSC 支：从 `chars[start]`（= ESC）起匹配，返回匹配结束下标（不含）。
fn match_osc(chars: &[char], start: usize) -> Option<usize> {
    if chars.get(start + 1) != Some(&']') {
        return None;
    }
    let mut i = start + 2;
    while let Some(&c) = chars.get(i) {
        if c == BEL {
            return Some(i + 1);
        }
        if c == ESC {
            return if chars.get(i + 1) == Some(&'\\') { Some(i + 2) } else { None };
        }
        i += 1;
    }
    None
}

/// 参数段 `(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?` 的最长匹配长度（从 pos 起）。
fn param_span(chars: &[char], pos: usize) -> usize {
    let digits = |from: usize, max: usize| -> usize {
        let mut n = 0;
        while n < max && chars.get(from + n).is_some_and(char::is_ascii_digit) {
            n += 1;
        }
        n
    };
    let head = digits(pos, 4);
    if head == 0 {
        return 0;
    }
    let mut len = head;
    while chars.get(pos + len) == Some(&';') {
        len += 1 + digits(pos + len + 1, 4);
    }
    len
}

/// CSI/其它 ESC 序列支：返回匹配结束下标（不含）。
fn match_csi(chars: &[char], start: usize) -> Option<usize> {
    let mut pos = start + 1;
    while chars.get(pos).is_some_and(|&c| is_intermediate(c)) {
        pos += 1;
    }
    let longest = param_span(chars, pos);
    // 回溯：参数段任意前缀都仍满足参数文法，且其中的数字本身也在终止符集合里。
    for len in (0..=longest).rev() {
        if chars.get(pos + len).is_some_and(|&c| is_final(c)) {
            return Some(pos + len + 1);
        }
    }
    None
}

/// 剥掉 ANSI/OSC 转义与 C0 控制字符，保留 \t 与 \n。
pub fn strip_ansi(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ESC {
            if let Some(end) = match_osc(&chars, i).or_else(|| match_csi(&chars, i)) {
                i = end;
            } else {
                i += 1; // 第三支：ESC 自身也是 C0 控制符
            }
            continue;
        }
        if !is_c0_control(c) {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// 取最后 n 行并去掉尾部空行——VT snapshot 的下半屏通常是成片空行，对 agent 是纯噪音。
pub fn tail_lines(text: &str, n: usize) -> String {
    let mut lines: Vec<&str> = text.split('\n').collect();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sgr_and_cursor_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m plain"), "red plain");
        assert_eq!(strip_ansi("\x1b[2J\x1b[1;1Hhome"), "home");
        assert_eq!(strip_ansi("\x1b[?25l\x1b[?25hx"), "x");
        assert_eq!(strip_ansi("a\x1b(Bb"), "ab");
    }

    #[test]
    fn strips_osc_with_bel_or_st() {
        assert_eq!(strip_ansi("\x1b]0;title\x07body"), "body");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link"), "link");
    }

    #[test]
    fn unterminated_osc_falls_back_like_the_regex() {
        // OSC 没有收尾符：第二支把 `]` 当中间字节、`0;` 当参数段、`t` 当终止符——与正则一致。
        assert_eq!(strip_ansi("\x1b]0;title rest"), "itle rest");
    }

    #[test]
    fn backtracks_into_parameter_digits() {
        // `ESC[12` 没有终止符：回溯后 `2` 充当终止符，整段被吃掉。
        assert_eq!(strip_ansi("\x1b[12"), "");
        // `ESC[1;`：回溯到 `1` 作终止符，`;` 留下。
        assert_eq!(strip_ansi("\x1b[1;"), ";");
        // 单独一个 ESC 按 C0 控制符删除。
        assert_eq!(strip_ansi("a\x1bz"), "az");
    }

    #[test]
    fn drops_c0_controls_but_keeps_tab_and_newline() {
        assert_eq!(strip_ansi("a\tb\r\nc\x07d\x7f"), "a\tb\ncd");
    }

    #[test]
    fn tail_lines_trims_trailing_blank_lines_then_takes_last_n() {
        assert_eq!(tail_lines("a\nb\nc\n\n  \n", 2), "b\nc");
        assert_eq!(tail_lines("a\nb", 10), "a\nb");
        assert_eq!(tail_lines("\n\n", 3), "");
        assert_eq!(tail_lines("", 3), "");
    }
}
