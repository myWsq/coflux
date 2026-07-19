//! per-session DEC 私有模式（`CSI ? Pm h` / `CSI ? Pm l`，如 bracketed-paste `?2004h`）追踪。
//!
//! 背景：supervisor 的 scrollback 是有界字节环（`crates/supervisor/src/main.rs` 里的
//! `scrollback_limit`），claude code 等 CLI 启动时发的模式设置转义一旦被挤出环，新 client
//! attach/resync 拿到的 replay 里就永远缺这段前缀，导致 server 镜像/web xterm 侧模式状态
//! （如 bracketed-paste）跟真实终端脱节。这里在 worker 层旁路观察经过的 PTY 字节，转发
//! replay 时把"被挤掉前缀的净效果"补在前面——纯观察，绝不修改/延迟转发的原始字节本身。

use std::collections::HashSet;

/// 单个不完整转义序列最长再等多少字节：超过即视为畸形/超界，放弃该序列（不影响已转发字节，
/// 只是这次不追踪）。同时也是已知激活模式集合的数量上限，防止异常输入把两者都撑爆。
const MAX_PENDING: usize = 64;
const MAX_MODES: usize = 64;

#[derive(Clone, Copy, PartialEq)]
enum State {
    Ground,
    Esc,
    Csi,
}

/// 单个 PTY 会话的模式追踪状态。`feed` 可跨多次调用增量喂入字节（转义序列可能跨 chunk
/// 边界），内部状态机自身就是"跨界不完整序列尾部"的有界缓冲。
pub struct DecModeTracker {
    modes: HashSet<u16>,
    state: State,
    private: bool,
    params: Vec<u8>,
}

impl Default for DecModeTracker {
    fn default() -> Self {
        Self { modes: HashSet::new(), state: State::Ground, private: false, params: Vec::new() }
    }
}

impl DecModeTracker {
    /// 旁路观察一段 PTY 字节（live 输出或 replay 数据），更新已知 DEC 私有模式集合。
    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                State::Ground => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    if b == b'[' {
                        self.state = State::Csi;
                        self.private = false;
                        self.params.clear();
                    } else {
                        self.state = State::Ground; // 非 CSI 转义（如 OSC/单字符），不关心
                    }
                }
                State::Csi => {
                    if b == b'?' && self.params.is_empty() && !self.private {
                        self.private = true;
                        continue;
                    }
                    if (0x30..=0x3f).contains(&b) {
                        // 参数字节（数字/';'/其它标点）
                        if self.params.len() >= MAX_PENDING {
                            self.state = State::Ground; // 序列超界，放弃（不影响转发，只是不追踪）
                            continue;
                        }
                        self.params.push(b);
                    } else if (0x40..=0x7e).contains(&b) {
                        // final byte：序列结束
                        if self.private && (b == b'h' || b == b'l') {
                            self.apply(b == b'h');
                        }
                        self.state = State::Ground;
                    } else {
                        // intermediate byte 或异常字节：不是我们关心的形状
                        self.state = State::Ground;
                    }
                }
            }
        }
    }

    fn apply(&mut self, set: bool) {
        for tok in self.params.split(|&b| b == b';') {
            if tok.is_empty() {
                continue;
            }
            let Ok(s) = std::str::from_utf8(tok) else { continue };
            let Ok(n) = s.parse::<u16>() else { continue };
            if set {
                if self.modes.len() < MAX_MODES {
                    self.modes.insert(n);
                }
            } else {
                self.modes.remove(&n);
            }
        }
    }

    /// 当前已知激活模式集合的 DECSET 前缀字节（各模式各一条 `ESC[?Nh`，顺序无关；
    /// 集合为空则返回空 Vec）。转发 replay 时前置此前缀 = 被环挤掉前缀的净效果，
    /// 回放剩余字节后自然收敛到真值。
    pub fn prefix(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for n in &self.modes {
            out.extend_from_slice(format!("\x1b[?{n}h").as_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_set_and_reset() {
        let mut t = DecModeTracker::default();
        t.feed(b"hello \x1b[?2004h world");
        assert_eq!(t.prefix(), b"\x1b[?2004h");
        t.feed(b"\x1b[?2004l");
        assert_eq!(t.prefix(), b"");
    }

    #[test]
    fn tracks_multi_param_sequence() {
        let mut t = DecModeTracker::default();
        t.feed(b"\x1b[?1049;2004h");
        let mut modes: Vec<_> = t.prefix().split(|&b| b == 0x1b).filter(|s| !s.is_empty()).map(|s| s.to_vec()).collect();
        modes.sort();
        assert_eq!(modes, vec![b"[?1049h".to_vec(), b"[?2004h".to_vec()]);
    }

    #[test]
    fn survives_chunk_boundary_split_mid_escape() {
        let mut t = DecModeTracker::default();
        t.feed(b"abc\x1b[?");
        t.feed(b"2004h");
        assert_eq!(t.prefix(), b"\x1b[?2004h");
    }

    #[test]
    fn non_private_csi_is_ignored() {
        let mut t = DecModeTracker::default();
        t.feed(b"\x1b[31m"); // SGR 颜色，非 DEC 私有模式
        assert_eq!(t.prefix(), b"");
    }

    #[test]
    fn oversized_sequence_is_abandoned_without_panic() {
        let mut t = DecModeTracker::default();
        let junk = vec![b'0'; 200];
        t.feed(b"\x1b[?");
        t.feed(&junk);
        t.feed(b"h");
        assert_eq!(t.prefix(), b""); // 超界序列被放弃，不污染集合
    }
}
