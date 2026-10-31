//! sessiond 的纯状态核心：VT grid/history、规范化 ANSI snapshot、输出序号与 channel stream。
//!
//! The VT engine is libghostty-vt, owned by one thread per session (see [`vt`]); unit tests
//! replay the ANSI snapshot into a second libghostty terminal to check state equivalence. PTY
//! lifetimes and Device channel routing stay in `sessions.rs`.

use std::collections::{HashMap, VecDeque};

use coflux_protocol::ipc::CommandStateInfo;

mod vt;

const RETRANSMIT_LIMIT: usize = 512 * 1024;
/// Parameter slots xterm.js keeps for a CSI (and the pre-libghostty runtime kept): digits past
/// them never make a DA1 query non-zero, so DA1 recognition stays what clients answer.
const XTERM_CSI_PARAM_SLOTS: u8 = 32;
/// logical identity 的 transport generation 与 input/resize cursor 必须保留到 session 结束，
/// 否则淘汰旧项会破坏同一 supervisor runtime 内的去重。达到上限后只拒绝新 identity；已登记
/// identity 仍可迁移 transport、提交在途 input 并推进 cursor。
const LOGICAL_CLIENT_LIMIT: usize = 256;

/// Prefix of the synthetic identities through which agents write to a PTY (plan 088): both their
/// channel ids and their client instance ids start with it. A holder with such an identity never
/// answers terminal queries, so sessiond answers them itself (see [`SessionState::feed`]).
pub(crate) const AGENT_IDENTITY_PREFIX: &str = "__coflux-agent-";

/// sessiond's reply to a DA1 query, the same one xterm.js gives: a DEC VT-100 with Advanced Video Option.
const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

/// What a byte of PTY output completed, as far as sessiond itself cares.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanEvent {
    /// The final byte of a DA1 query (`CSI c` / `CSI 0 c`).
    Da1Query,
    /// The final byte of a DECSET naming mode 2027 (grapheme clustering), which sessiond keeps off.
    GraphemeClusterSet,
    /// An OSC 0/2 title, raw and unclamped.
    Title(Vec<u8>),
    /// An OSC 133 mark that presented the session secret.
    Mark(Mark),
}

/// Lightweight scanner that follows libghostty-vt's parser states on the feeding thread, so
/// sessiond never has to ask the terminal thread anything while feeding. It answers:
///
/// - **Is it safe to cut here?** A checkpoint may only fall between two sequences
///   ([`OutputScanner::between_sequences`]). Cut inside an OSC 133 mark and the replay types its
///   tail (`coflux=<secret>`) into screen and history, exposing the very secret marks are checked
///   against; cut inside a multi-byte character and the new terminal prints a broken one. A quiet
///   PTY only decides when the supervisor asks; it is never the boundary itself: a shell may well
///   write one OSC in two `write(2)`s further apart than the batching window.
/// - **Did this byte complete a DA1 query, a DECSET of mode 2027, a title or a mark?** See
///   [`ScanEvent`]. Titles and marks are captured here, from a bounded payload buffer, rather
///   than through libghostty callbacks, which run on the terminal thread.
///
/// The states mirror libghostty's parse table: CAN/SUB abort any sequence and ESC starts a new
/// one; outside ground, the 8-bit C1 bytes 0x80-0x9F start or end sequences as the table says,
/// except inside OSC and DCS payloads, where every byte from 0x20 up is payload; in ground every
/// byte is UTF-8 (C1 never introduces a sequence there). Parameter and intermediate counts and
/// colon separators decide only whether libghostty dispatches a CSI, never where it ends, so the
/// scanner does not need them: DA1 keeps the xterm.js semantics clients answer with, and a DECSET
/// of 2027 is reported even when libghostty would drop it, since forcing an off mode off again is
/// a no-op.
#[derive(Debug, Default)]
struct OutputScanner {
    state: ScanState,
    /// Ground 态里尚未收齐的 UTF-8 续字节数。
    utf8_pending: u8,
    osc: OscCapture,
    /// Secret the shell must present in every mark; empty = no marks are ever accepted.
    secret: String,
}

#[derive(Debug, Default)]
enum ScanState {
    #[default]
    Ground,
    Escape,
    EscapeIntermediate,
    Csi(CsiScan),
    /// `ESC ]` … BEL / ST. ESC leaves it (and dispatches it); CAN/SUB abort it.
    Osc,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    /// DCS passthrough or ignore: only ESC, CAN and SUB leave it.
    DcsBody,
    /// `ESC X` / `ESC ^` / `ESC _` … ST.
    SosPmApc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CsiPhase {
    Entry,
    Parameter,
    Intermediate,
    Ignore,
}

#[derive(Debug, Clone, Copy)]
struct CsiScan {
    phase: CsiPhase,
    /// Only parameter bytes (digits, `;`, `:`) so far: no private marker, no intermediate. With
    /// all-zero parameters and final `c` that is a DA1 query, the same as xterm.js decides.
    da1_shape: bool,
    da1_nonzero: bool,
    da1_slots: u8,
    /// `?` opened the sequence (a DEC private mode set/reset).
    question: bool,
    value: u16,
    has_digit: bool,
    names_2027: bool,
}

impl CsiScan {
    fn new() -> Self {
        Self {
            phase: CsiPhase::Entry,
            da1_shape: true,
            da1_nonzero: false,
            da1_slots: 0,
            question: false,
            value: 0,
            has_digit: false,
            names_2027: false,
        }
    }

    fn end_parameter(&mut self) {
        if self.has_digit && self.value == 2027 {
            self.names_2027 = true;
        }
        self.value = 0;
        self.has_digit = false;
    }

    /// One byte inside a CSI; `Some` once the final byte ends it.
    fn feed(&mut self, byte: u8) -> Option<Option<ScanEvent>> {
        match byte {
            b'0'..=b'9' => {
                if self.da1_shape && self.da1_slots < XTERM_CSI_PARAM_SLOTS && byte != b'0' {
                    self.da1_nonzero = true;
                }
                if self.question {
                    self.value = self
                        .value
                        .saturating_mul(10)
                        .saturating_add(u16::from(byte - b'0'));
                    self.has_digit = true;
                }
                self.phase = match self.phase {
                    CsiPhase::Entry | CsiPhase::Parameter => CsiPhase::Parameter,
                    CsiPhase::Intermediate | CsiPhase::Ignore => CsiPhase::Ignore,
                };
            }
            b';' | b':' => {
                if self.da1_shape && self.da1_slots < XTERM_CSI_PARAM_SLOTS {
                    self.da1_slots += 1;
                }
                if self.question {
                    self.end_parameter();
                }
                self.phase = match (self.phase, byte) {
                    // libghostty ignores a CSI that starts with a colon.
                    (CsiPhase::Entry, b':') => CsiPhase::Ignore,
                    (CsiPhase::Entry | CsiPhase::Parameter, _) => CsiPhase::Parameter,
                    _ => CsiPhase::Ignore,
                };
            }
            0x3c..=0x3f => {
                self.da1_shape = false;
                self.phase = match self.phase {
                    CsiPhase::Entry => {
                        self.question = byte == b'?';
                        CsiPhase::Parameter
                    }
                    _ => CsiPhase::Ignore,
                };
            }
            0x20..=0x2f => {
                self.da1_shape = false;
                if self.phase != CsiPhase::Ignore {
                    self.phase = CsiPhase::Intermediate;
                }
            }
            0x40..=0x7e => {
                if self.question {
                    self.end_parameter();
                }
                let event = if byte == b'c' && self.da1_shape && !self.da1_nonzero {
                    Some(ScanEvent::Da1Query)
                } else if byte == b'h' && self.question && self.names_2027 {
                    Some(ScanEvent::GraphemeClusterSet)
                } else {
                    None
                };
                return Some(event);
            }
            // C0 controls execute, DEL and 0xA0-0xFF are ignored: the sequence goes on.
            _ => {}
        }
        None
    }
}

impl OutputScanner {
    fn with_secret(secret: String) -> Self {
        Self {
            secret,
            ..Self::default()
        }
    }

    /// 此刻是否处在两条序列之间（且不在多字节字符中间）：checkpoint 只允许落在这里。
    fn between_sequences(&self) -> bool {
        matches!(self.state, ScanState::Ground) && self.utf8_pending == 0
    }

    /// Whether libghostty honours an 8-bit C1 byte in the current state: everywhere outside
    /// ground except inside OSC and DCS payloads, where high bytes are payload data.
    fn honours_c1(&self) -> bool {
        !matches!(
            self.state,
            ScanState::Ground | ScanState::Osc | ScanState::DcsBody
        )
    }

    fn enter(&mut self, next: ScanState) {
        if matches!(next, ScanState::Osc) {
            self.osc.reset();
        }
        self.state = next;
    }

    fn feed(&mut self, byte: u8) -> Option<ScanEvent> {
        if matches!(self.state, ScanState::Ground) {
            if byte == 0x1b {
                self.state = ScanState::Escape;
                self.utf8_pending = 0;
                return None;
            }
            // 只为"切一刀是否安全"跟踪 UTF-8 续字节。
            self.utf8_pending = match byte {
                0x80..=0xbf => self.utf8_pending.saturating_sub(1),
                0xc2..=0xdf => 1,
                0xe0..=0xef => 2,
                0xf0..=0xf4 => 3,
                _ => 0,
            };
            return None;
        }

        // Transitions libghostty takes from any state.
        let anywhere = match byte {
            0x18 | 0x1a => Some(ScanState::Ground),
            0x1b => Some(ScanState::Escape),
            0x80..=0x9f if self.honours_c1() => Some(match byte {
                0x90 => ScanState::DcsEntry,
                0x98 | 0x9e | 0x9f => ScanState::SosPmApc,
                0x9b => ScanState::Csi(CsiScan::new()),
                0x9d => ScanState::Osc,
                _ => ScanState::Ground,
            }),
            _ => None,
        };
        if let Some(next) = anywhere {
            // ESC ends an OSC the way ST does (the `\` that follows is an ESC dispatch of its
            // own); CAN and SUB abort it.
            let event = (matches!(self.state, ScanState::Osc) && byte == 0x1b)
                .then(|| self.dispatch_osc())
                .flatten();
            self.enter(next);
            return event;
        }

        let next = match &mut self.state {
            ScanState::Ground => unreachable!("ground is handled above"),
            ScanState::Escape => match byte {
                0x20..=0x2f => Some(ScanState::EscapeIntermediate),
                b'P' => Some(ScanState::DcsEntry),
                b'X' | b'^' | b'_' => Some(ScanState::SosPmApc),
                b'[' => Some(ScanState::Csi(CsiScan::new())),
                b']' => Some(ScanState::Osc),
                0x30..=0x7e => Some(ScanState::Ground),
                _ => None,
            },
            ScanState::EscapeIntermediate => match byte {
                0x30..=0x7e => Some(ScanState::Ground),
                _ => None,
            },
            ScanState::Csi(scan) => match scan.feed(byte) {
                Some(event) => {
                    self.state = ScanState::Ground;
                    return event;
                }
                None => None,
            },
            ScanState::Osc => match byte {
                0x07 => {
                    let event = self.dispatch_osc();
                    self.state = ScanState::Ground;
                    return event;
                }
                0x20..=0xff => {
                    self.osc.put(byte);
                    None
                }
                _ => None,
            },
            ScanState::DcsEntry => match byte {
                0x20..=0x2f => Some(ScanState::DcsIntermediate),
                b':' | 0x40..=0x7e => Some(ScanState::DcsBody),
                0x30..=0x39 | b';' | 0x3c..=0x3f => Some(ScanState::DcsParam),
                _ => None,
            },
            ScanState::DcsParam => match byte {
                0x20..=0x2f => Some(ScanState::DcsIntermediate),
                b':' | 0x3c..=0x3f | 0x40..=0x7e => Some(ScanState::DcsBody),
                _ => None,
            },
            ScanState::DcsIntermediate => match byte {
                0x30..=0x7e => Some(ScanState::DcsBody),
                _ => None,
            },
            ScanState::DcsBody | ScanState::SosPmApc => None,
        };
        if let Some(next) = next {
            self.enter(next);
        }
        None
    }

    fn dispatch_osc(&mut self) -> Option<ScanEvent> {
        let capture = std::mem::take(&mut self.osc);
        if capture.kind != OscKind::Wanted {
            return None;
        }
        let params: Vec<&[u8]> = capture
            .payload
            .splitn(OSC_PARAM_LIMIT, |byte| *byte == b';')
            .collect();
        match params.as_slice() {
            [b"0", title] | [b"2", title] => Some(ScanEvent::Title(title.to_vec())),
            // A cut payload could pass a secret prefix for the whole secret: never a mark.
            [b"133", ..] if !capture.truncated => {
                parse_mark(&params, &self.secret).map(ScanEvent::Mark)
            }
            _ => None,
        }
    }
}

/// OSC 标题的长度钳制（plan 075）：标题是 PTY 内程序给的不可信输入，源头截断。
const MAX_TITLE_BYTES: usize = 256;

/// OSC payload bytes captured for titles and marks. A longer OSC 0/2 keeps its first bytes (its
/// title is clamped to [`MAX_TITLE_BYTES`] anyway); a longer OSC 133 is never a mark.
const OSC_CAPTURE_BYTES: usize = 4096;

/// OSC parameters split on `;`, as the pre-libghostty runtime did: the last one keeps any further separators.
const OSC_PARAM_LIMIT: usize = 16;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum OscKind {
    /// The command number is not complete yet.
    #[default]
    Undecided,
    /// OSC 0, 2 or 133: captured.
    Wanted,
    /// Anything else: not captured.
    Ignored,
}

/// The payload of the OSC being scanned, kept only for the commands sessiond reads.
#[derive(Debug, Default)]
struct OscCapture {
    payload: Vec<u8>,
    kind: OscKind,
    truncated: bool,
}

impl OscCapture {
    fn reset(&mut self) {
        self.payload.clear();
        self.kind = OscKind::Undecided;
        self.truncated = false;
    }

    fn put(&mut self, byte: u8) {
        match self.kind {
            OscKind::Ignored => return,
            OscKind::Undecided if byte == b';' => {
                self.kind = if matches!(self.payload.as_slice(), b"0" | b"2" | b"133") {
                    OscKind::Wanted
                } else {
                    OscKind::Ignored
                };
                if self.kind == OscKind::Ignored {
                    self.payload = Vec::new();
                    return;
                }
            }
            OscKind::Undecided if self.payload.len() >= 3 => {
                self.kind = OscKind::Ignored;
                self.payload = Vec::new();
                return;
            }
            _ => {}
        }
        if self.payload.len() < OSC_CAPTURE_BYTES {
            self.payload.push(byte);
        } else {
            self.truncated = true;
        }
    }
}

/// A shell-integration mark accepted from the PTY output (OSC 133 carrying this session's secret).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mark {
    /// `133;A`: the shell is about to draw its prompt — the only moment do-script may type.
    PromptStart,
    /// `133;C`: a command line was accepted and is starting.
    CommandStart,
    /// `133;D;<exit>`: the command finished; `None` when the shell gave no status.
    CommandEnd(Option<i32>),
}

/// Parameter that every accepted mark must present, followed by the session secret.
const MARK_SECRET_PARAM: &[u8] = b"coflux=";

/// Marks are keyed on the per-session secret: OSC 133 from remote hosts, nested shells or prompt
/// frameworks never presents it and is dropped here, before any state changes. Without a secret
/// nothing is accepted.
fn parse_mark(params: &[&[u8]], secret: &str) -> Option<Mark> {
    if secret.is_empty() || params.first().copied() != Some(&b"133"[..]) {
        return None;
    }
    let presented = params.iter().skip(2).any(|param| {
        param
            .strip_prefix(MARK_SECRET_PARAM)
            .is_some_and(|presented| presented == secret.as_bytes())
    });
    if !presented {
        return None;
    }
    match params.get(1).copied() {
        Some(b"A") => Some(Mark::PromptStart),
        Some(b"C") => Some(Mark::CommandStart),
        Some(b"D") => Some(Mark::CommandEnd(
            params
                .get(2)
                .and_then(|raw| std::str::from_utf8(raw).ok())
                .and_then(|text| text.parse::<i32>().ok()),
        )),
        _ => None,
    }
}

/// Per-session command state machine fed by accepted marks. `changed` is set whenever a mark
/// moved the state so sessions.rs can push the new state to the worker right after the feed.
#[derive(Default)]
struct CommandTracker {
    state: CommandStateInfo,
    changed: bool,
}

impl CommandTracker {
    fn apply(&mut self, mark: Mark) {
        let before = self.state;
        let state = &mut self.state;
        state.integrated = true;
        match mark {
            Mark::PromptStart => {
                // A prompt without a command-end: the shell was replaced (`exec`) or a hook was
                // skipped. Close the command with an unknown status rather than staying busy forever.
                if state.busy {
                    state.busy = false;
                    state.finished_seq = state.command_seq;
                    state.exit_code = None;
                }
            }
            Mark::CommandStart => {
                state.command_seq = state.command_seq.saturating_add(1);
                state.busy = true;
            }
            Mark::CommandEnd(code) => {
                // An end without a start (the start mark was lost) still counts as one command so
                // the sequence a caller was promised keeps lining up.
                if !state.busy {
                    state.command_seq = state.command_seq.saturating_add(1);
                }
                state.busy = false;
                state.finished_seq = state.command_seq;
                state.exit_code = code;
            }
        }
        if *state != before {
            self.changed = true;
        }
    }
}

/// 不可信标题的规范化：lossy 解码、剔除控制字符、按字符边界截到 MAX_TITLE_BYTES。
fn clamp_title(raw: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(raw)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if text.len() <= MAX_TITLE_BYTES {
        return text;
    }
    let mut end = MAX_TITLE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Offsets of the final bytes of the DECSETs of mode 2027 in `bytes`, scanned from ground. Used
/// for canonical snapshots replayed into a fresh terminal, which never carry titles or marks.
fn grapheme_resets(bytes: &[u8]) -> Vec<usize> {
    let mut scanner = OutputScanner::default();
    bytes
        .iter()
        .enumerate()
        .filter(|(_, byte)| scanner.feed(**byte) == Some(ScanEvent::GraphemeClusterSet))
        .map(|(index, _)| index)
        .collect()
}

pub struct TerminalState {
    /// The libghostty terminal, on its own thread. Every read waits behind the feeds queued
    /// before it, so it always matches `output_seq`.
    vt: vt::VtHandle,
    scanner: OutputScanner,
    /// PTY 内程序经 OSC 0/2 设置的终端标题；空 = 从未设置。跨 resize 存续。
    title: String,
    /// The title changed since the last [`TerminalState::take_title_change`]; lets sessiond push a
    /// title event instead of the runtime rendering snapshots to learn it
    /// (plan 20261010-terminal-checkpoint-energy).
    title_changed: bool,
    command: CommandTracker,
    rows: u16,
    cols: u16,
    history_line_limit: usize,
    output_seq: u64,
    retransmit: VecDeque<Delta>,
    retransmit_bytes: usize,
    /// Output seqs of the final bytes of the DA1 queries completed by the last `feed`.
    da1_queries: Vec<u64>,
    /// Output seq of the final byte of the last terminal query sessiond answered itself; 0 = none.
    /// A client resuming below it would receive that query raw and answer it a second time, so
    /// such a resume gets a snapshot instead. Carried in checkpoints across sessiond rebuilds.
    answered_query_seq: u64,
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16, history_line_limit: usize) -> Self {
        Self {
            vt: vt::VtHandle::spawn(rows, cols, history_line_limit),
            scanner: OutputScanner::default(),
            title: String::new(),
            title_changed: false,
            command: CommandTracker::default(),
            rows,
            cols,
            history_line_limit,
            output_seq: 0,
            retransmit: VecDeque::new(),
            retransmit_bytes: 0,
            da1_queries: Vec::new(),
            answered_query_seq: 0,
        }
    }

    /// Install the per-session secret that shell-integration marks must present. Without it every
    /// OSC 133 sequence is ignored (unit tests and unknown shells).
    pub fn with_mark_secret(mut self, secret: String) -> Self {
        self.scanner.secret = secret;
        self
    }

    /// Hand the bytes to the terminal thread without waiting for them to be applied; title,
    /// marks, DA1 queries and the checkpoint boundary come from the scanner on this thread.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<Delta> {
        self.da1_queries.clear();
        if bytes.is_empty() {
            return None;
        }
        let from_seq = self.output_seq.saturating_add(1);

        let mut grapheme_resets = Vec::new();
        let mut pending_title = None;
        for (index, byte) in bytes.iter().copied().enumerate() {
            match self.scanner.feed(byte) {
                None => {}
                Some(ScanEvent::Da1Query) => {
                    self.da1_queries.push(from_seq.saturating_add(index as u64));
                }
                Some(ScanEvent::GraphemeClusterSet) => grapheme_resets.push(index),
                // The last title of a chunk wins, as it always has.
                Some(ScanEvent::Title(raw)) => pending_title = Some(raw),
                Some(ScanEvent::Mark(mark)) => self.command.apply(mark),
            }
        }
        if let Some(pending) = pending_title {
            let title = clamp_title(&pending);
            if title != self.title {
                self.title = title;
                self.title_changed = true;
            }
        }
        self.vt.feed(bytes.to_vec(), grapheme_resets);

        self.output_seq = self.output_seq.saturating_add(bytes.len() as u64);
        let delta = Delta {
            from_seq,
            to_seq: self.output_seq,
            data: bytes.to_vec(),
        };
        self.push_retransmit(delta.clone());
        Some(delta)
    }

    /// checkpoint 只能落在两条序列之间（见 [`OutputScanner::between_sequences`]）。
    pub fn checkpoint_eligible(&self) -> bool {
        self.scanner.between_sequences()
    }

    /// Output seqs of the final bytes of the DA1 queries the last `feed` completed, in order.
    /// Only `feed` records them: `resize` and `restore` replay canonical snapshots, never queries.
    pub fn take_da1_queries(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.da1_queries)
    }

    /// See `answered_query_seq`.
    pub fn answered_query_seq(&self) -> u64 {
        self.answered_query_seq
    }

    /// Raise the answered-query marker to `seq`; it never moves down.
    pub fn raise_answered_query_seq(&mut self, seq: u64) {
        self.answered_query_seq = self.answered_query_seq.max(seq);
    }

    /// 从 checkpoint 重建：把规范 snapshot 喂给新 terminal，再装回 snapshot 编码不了的那些状态。
    /// 之后调用方按偏移把 ring 里 `[output_seq, now)` 的字节逐段 `feed` 进来。`normal_before_alt`
    /// is never fed: the snapshot already starts with the primary screen.
    pub fn restore(
        checkpoint: &Checkpoint,
        history_line_limit: usize,
        mark_secret: String,
    ) -> Self {
        let vt = vt::VtHandle::spawn(checkpoint.rows, checkpoint.cols, history_line_limit);
        vt.feed(
            checkpoint.snapshot.clone(),
            grapheme_resets(&checkpoint.snapshot),
        );
        vt.barrier();
        Self {
            vt,
            scanner: OutputScanner::with_secret(mark_secret),
            title: checkpoint.title.clone(),
            title_changed: false,
            command: CommandTracker {
                state: checkpoint.command,
                changed: false,
            },
            rows: checkpoint.rows,
            cols: checkpoint.cols,
            history_line_limit,
            output_seq: checkpoint.output_seq,
            retransmit: VecDeque::new(),
            retransmit_bytes: 0,
            da1_queries: Vec::new(),
            answered_query_seq: checkpoint.answered_query_seq,
        }
    }

    /// 退化重建（没有可用 blob）：屏幕从空白开始，序号从 ring 起点接上。
    pub fn set_output_seq(&mut self, output_seq: u64) {
        self.output_seq = output_seq;
        self.retransmit.clear();
        self.retransmit_bytes = 0;
    }

    /// 当前状态打成 checkpoint。snapshot 太大时按逻辑行数减半直到装进 `max_bytes`（只影响
    /// 这份 checkpoint 的回滚深度，不影响在跑的 history）；连一屏都装不下才返回 None。
    pub fn checkpoint(&self, max_bytes: usize) -> Option<Checkpoint> {
        let mut line_limit = self.history_line_limit;
        loop {
            let rendered = self.vt.render(line_limit);
            let checkpoint = Checkpoint {
                output_seq: self.output_seq,
                rows: self.rows,
                cols: self.cols,
                title: self.title.clone(),
                command: self.command.state,
                answered_query_seq: self.answered_query_seq,
                normal_before_alt: rendered.primary,
                snapshot: rendered.snapshot,
            };
            if checkpoint.encoded_len() <= max_bytes {
                return Some(checkpoint);
            }
            if line_limit == 0 {
                return None;
            }
            line_limit /= 2;
        }
    }

    /// ring 里最早仍可回放的序号（1 起）：ring 覆盖最近 `PTYD_RING_CAPACITY` 个输出字节。
    pub fn ring_floor_seq(&self) -> u64 {
        self.output_seq
            .saturating_sub(coflux_protocol::ptyd::PTYD_RING_CAPACITY)
            .saturating_add(1)
    }

    fn push_retransmit(&mut self, delta: Delta) {
        if delta.data.len() > RETRANSMIT_LIMIT {
            self.retransmit.clear();
            self.retransmit_bytes = 0;
            return;
        }
        self.retransmit_bytes += delta.data.len();
        self.retransmit.push_back(delta);
        while self.retransmit_bytes > RETRANSMIT_LIMIT {
            if let Some(removed) = self.retransmit.pop_front() {
                self.retransmit_bytes -= removed.data.len();
            }
        }
    }

    /// The canonical ANSI snapshot at `output_seq`: a full reset, at most `history_line_limit`
    /// logical lines of history and the screen. While the alternate screen is active: the primary
    /// screen's snapshot, `?1049h`, then the alternate screen with its modes.
    pub fn snapshot(&self) -> Vec<u8> {
        self.vt.render(self.history_line_limit).snapshot
    }

    /// libghostty's native resize: the primary screen reflows its logical lines (the alternate
    /// screen does not), and the scrollback budget follows the new width.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        if self.rows == rows && self.cols == cols {
            return;
        }
        self.vt.resize(rows, cols);
        self.rows = rows;
        self.cols = cols;
    }

    pub fn output_seq(&self) -> u64 {
        self.output_seq
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// The title if an OSC 0/2 changed it since the last call; `None` otherwise. Setting the same
    /// title again is not a change.
    pub fn take_title_change(&mut self) -> Option<String> {
        if !self.title_changed {
            return None;
        }
        self.title_changed = false;
        Some(self.title.clone())
    }

    /// Current shell-integration command state (busy / sequence / last exit).
    pub fn command_state(&self) -> CommandStateInfo {
        self.command.state
    }

    /// The command state if a mark changed it since the last call; `None` otherwise.
    pub fn take_command_change(&mut self) -> Option<CommandStateInfo> {
        if !self.command.changed {
            return None;
        }
        self.command.changed = false;
        Some(self.command.state)
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn earliest_retransmit_seq(&self) -> u64 {
        self.retransmit
            .front()
            .map(|delta| delta.from_seq)
            .unwrap_or_else(|| self.output_seq.saturating_add(1))
    }

    /// 从 `last_seq` 之后按**字节偏移**切片：seq 就是字节偏移，落在某条 delta 中间也定义良好。
    /// 只在本地 retransmit 缓冲覆盖不到时返回 None（调用方再去 ptyd 的 ring 里取）。
    /// 过去只在 `from_seq` 恰好是 batch 边界时才回答，重放会把流重新分帧，那样每个 client 的
    /// resume 都会退化成整屏重绘——看起来就像本功能没生效。
    fn deltas_after(&self, last_seq: u64) -> Option<Vec<Delta>> {
        if last_seq >= self.output_seq {
            return (last_seq == self.output_seq).then(Vec::new);
        }
        let expected = last_seq.checked_add(1)?;
        let start = self
            .retransmit
            .iter()
            .position(|delta| delta.from_seq <= expected && expected <= delta.to_seq)?;
        let mut next = expected;
        let mut output = Vec::new();
        for delta in self.retransmit.iter().skip(start) {
            if delta.from_seq > next || delta.to_seq < next {
                return None;
            }
            let skip = (next - delta.from_seq) as usize;
            output.push(Delta {
                from_seq: next,
                to_seq: delta.to_seq,
                data: delta.data[skip..].to_vec(),
            });
            next = delta.to_seq.saturating_add(1);
        }
        (next == self.output_seq.saturating_add(1)).then_some(output)
    }
}

/// supervisor 自己的 checkpoint 格式：对 ptyd 不透明，由 supervisor 版本化。新 supervisor 必须
/// 能读旧 supervisor 写的 blob；读不了就只回放 ring（接受上面说的模态状态丢失），绝不中止恢复。
/// 编码：`[u32 BE header_len][header JSON][normal_before_alt][snapshot]`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub output_seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub title: String,
    pub command: CommandStateInfo,
    /// See `TerminalState::answered_query_seq`; 0 in checkpoints written before it existed.
    pub answered_query_seq: u64,
    /// alt screen 激活时进入 alt 前的主屏 snapshot；否则 None。
    pub normal_before_alt: Option<Vec<u8>>,
    /// 规范 snapshot（alt 激活时已含 `?1049h` 与 alt 网格）。
    pub snapshot: Vec<u8>,
}

/// 只在不兼容改动时递增；新增可缺省字段不用动它。
const CHECKPOINT_FORMAT_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct CheckpointHeader {
    v: u32,
    output_seq: u64,
    rows: u16,
    cols: u16,
    title: String,
    command: CommandStateInfo,
    alt: bool,
    normal_len: u32,
    /// Additive: older runtimes ignore it, and headers written by them decode to 0.
    #[serde(default)]
    answered_query_seq: u64,
}

impl Checkpoint {
    fn header(&self) -> CheckpointHeader {
        CheckpointHeader {
            v: CHECKPOINT_FORMAT_VERSION,
            output_seq: self.output_seq,
            rows: self.rows,
            cols: self.cols,
            title: self.title.clone(),
            command: self.command,
            answered_query_seq: self.answered_query_seq,
            alt: self.normal_before_alt.is_some(),
            normal_len: self
                .normal_before_alt
                .as_ref()
                .map_or(0, |normal| normal.len() as u32),
        }
    }

    pub fn encoded_len(&self) -> usize {
        let header = serde_json::to_vec(&self.header()).unwrap_or_default();
        4 + header.len() + self.normal_before_alt.as_ref().map_or(0, Vec::len) + self.snapshot.len()
    }

    pub fn encode(&self) -> Vec<u8> {
        let header = serde_json::to_vec(&self.header()).unwrap_or_default();
        let mut out = Vec::with_capacity(self.encoded_len());
        out.extend_from_slice(&(header.len() as u32).to_be_bytes());
        out.extend_from_slice(&header);
        if let Some(normal) = &self.normal_before_alt {
            out.extend_from_slice(normal);
        }
        out.extend_from_slice(&self.snapshot);
        out
    }

    /// 解析失败（更老/更新的格式、损坏）返回 None：调用方退化为只回放 ring。
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 4 {
            return None;
        }
        let header_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let rest = bytes.get(4..)?;
        let header: CheckpointHeader = serde_json::from_slice(rest.get(..header_len)?).ok()?;
        if header.v != CHECKPOINT_FORMAT_VERSION || header.rows == 0 || header.cols == 0 {
            return None;
        }
        let body = rest.get(header_len..)?;
        let normal_len = header.normal_len as usize;
        if !header.alt && normal_len != 0 {
            return None;
        }
        let normal = body.get(..normal_len)?;
        let snapshot = body.get(normal_len..)?;
        Some(Self {
            output_seq: header.output_seq,
            rows: header.rows,
            cols: header.cols,
            title: header.title,
            command: header.command,
            answered_query_seq: header.answered_query_seq,
            normal_before_alt: header.alt.then(|| normal.to_vec()),
            snapshot: snapshot.to_vec(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    pub from_seq: u64,
    pub to_seq: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
struct Subscriber {
    next_seq: u64,
    gapped: bool,
    gap_notified: bool,
}

#[derive(Debug, Clone)]
struct Holder {
    client_instance_id: String,
    transport_generation: u64,
    channel_id: String,
    epoch: u64,
}

#[derive(Debug, Clone)]
struct TransportBinding {
    generation: u64,
    channel_id: String,
}

#[derive(Debug, Clone)]
pub struct DetachedTarget {
    pub channel_id: String,
    pub holder_epoch: u64,
}

#[derive(Debug, Clone)]
pub struct AttachOutcome {
    pub holder_epoch: u64,
    pub snapshot_seq: u64,
    pub ansi_snapshot: Option<Vec<u8>>,
    pub replay: Vec<Delta>,
    pub detached: Option<DetachedTarget>,
}

#[derive(Debug, Clone)]
pub struct PendingDelta {
    pub channel_id: String,
    pub delta: Delta,
}

#[derive(Debug, Clone)]
pub struct PendingGap {
    pub channel_id: String,
    pub expected_seq: u64,
    pub available_seq: u64,
}

#[derive(Debug, Clone)]
pub struct AttachError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SequencedDecision {
    Apply,
    Duplicate,
}

/// PTY input 在 session mutex 内完成 authority 裁决与 reservation，但实际写入由独立
/// writer 执行。`Pending` 表示同一 seq 已经排队/写入中；调用方不能再次入队，也不能在
/// 完整写入前提前 ACK。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputAdmission {
    Enqueue { client_instance_id: String },
    Pending,
    Duplicate { applied_through_seq: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputCompletion {
    pub channel_id: String,
    pub applied_through_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputFailureTarget {
    pub channel_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone)]
pub struct ControlError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
struct InputCursor {
    seq: u64,
    data: Vec<u8>,
}

#[derive(Debug, Clone)]
struct PendingInput {
    seq: u64,
    data: Vec<u8>,
    /// ACK/error 总是发往最近一次通过 holder 校验的 transport。worker 重连后同 seq
    /// 重投会刷新这里，避免写完后只向已经失效的旧 channel 回 ACK。
    channel_id: String,
    request_id: String,
}

#[derive(Debug, Clone)]
struct ResizeCursor {
    seq: u64,
    rows: u16,
    cols: u16,
}

/// PTY/网络无关的每-session authority；调用方在同一 mutex 内执行 attach/feed/send-result。
pub struct SessionState {
    terminal: TerminalState,
    subscribers: HashMap<String, Subscriber>,
    holder: Option<Holder>,
    transport_bindings: HashMap<String, TransportBinding>,
    next_holder_epoch: u64,
    input_cursors: HashMap<String, InputCursor>,
    input_reservations: HashMap<String, VecDeque<PendingInput>>,
    input_failure: Option<ControlError>,
    resize_cursors: HashMap<String, ResizeCursor>,
    /// 重建时拿不到 ptyd 的输入游标（旧 ptyd 没有 `cursors` op）：第一次见到某个 identity 就以它自报的
    /// seq 为起点接纳，重复 / 跳号交给 ptyd 那边的游标裁决——否则回来的 client 一律被判 `input_seq_gap`，
    /// 一个能力缺失就变成了死 ack。
    cursorless_rebuild: bool,
    /// Replies sessiond must write into the PTY for the queries the last `feed` completed;
    /// replaced by every `feed`. See [`SessionState::take_query_replies`].
    query_replies: Vec<Vec<u8>>,
}

impl SessionState {
    pub fn new(rows: u16, cols: u16, history_line_limit: usize) -> Self {
        Self {
            terminal: TerminalState::new(rows, cols, history_line_limit),
            subscribers: HashMap::new(),
            holder: None,
            transport_bindings: HashMap::new(),
            next_holder_epoch: 0,
            input_cursors: HashMap::new(),
            input_reservations: HashMap::new(),
            input_failure: None,
            resize_cursors: HashMap::new(),
            cursorless_rebuild: false,
            query_replies: Vec::new(),
        }
    }

    /// See [`TerminalState::with_mark_secret`].
    pub fn with_mark_secret(mut self, secret: String) -> Self {
        self.terminal = self.terminal.with_mark_secret(secret);
        self
    }

    /// 从 checkpoint 重建的 authority：holder / epoch 不跨越 supervisor 重启（client 走 stale_transport
    /// 重新 attach），输入游标由调用方从 ptyd 装回。
    pub fn restore(terminal: TerminalState) -> Self {
        Self {
            terminal,
            subscribers: HashMap::new(),
            holder: None,
            transport_bindings: HashMap::new(),
            next_holder_epoch: 0,
            input_cursors: HashMap::new(),
            input_reservations: HashMap::new(),
            input_failure: None,
            resize_cursors: HashMap::new(),
            cursorless_rebuild: false,
            query_replies: Vec::new(),
        }
    }

    /// 装回 ptyd 记录的输入游标：它是"什么真正写进了 PTY"的记录，重启后 client 重投的 seq 据此
    /// 判 duplicate / collision / gap。
    pub fn restore_input_cursor(&mut self, client_instance_id: &str, seq: u64, data: Vec<u8>) {
        self.input_cursors
            .insert(client_instance_id.to_string(), InputCursor { seq, data });
    }

    /// 重建时没有游标可装（ptyd 不提供 `cursors`）：见 `cursorless_rebuild`。
    pub fn set_cursorless_rebuild(&mut self) {
        self.cursorless_rebuild = true;
    }

    /// ptyd 按它自己的游标拒绝了这条输入（gap / collision / identity 上限）：弹掉队首的 reservation、
    /// 把错误交回给发它的 transport，session 与后续输入都不受影响（与 `fail_input` 封死 session 不同）。
    pub fn reject_pending_input(
        &mut self,
        client_instance_id: &str,
        input_seq: u64,
    ) -> Result<InputFailureTarget, ControlError> {
        let Some(reservations) = self.input_reservations.get_mut(client_instance_id) else {
            return Err(ControlError {
                code: "input_reservation_missing",
                message: "input reservation 不存在".into(),
            });
        };
        if reservations
            .front()
            .is_none_or(|pending| pending.seq != input_seq)
        {
            return Err(ControlError {
                code: "input_reservation_missing",
                message: "input reservation 顺序错误".into(),
            });
        }
        let pending = reservations.pop_front().unwrap();
        if reservations.is_empty() {
            self.input_reservations.remove(client_instance_id);
        }
        Ok(InputFailureTarget {
            channel_id: pending.channel_id,
            request_id: pending.request_id,
        })
    }

    pub fn checkpoint_eligible(&self) -> bool {
        self.terminal.checkpoint_eligible()
    }

    pub fn checkpoint(&self, max_bytes: usize) -> Option<Checkpoint> {
        self.terminal.checkpoint(max_bytes)
    }

    pub fn set_output_seq(&mut self, output_seq: u64) {
        self.terminal.set_output_seq(output_seq);
    }

    /// 只在本地重发缓冲之外、ring 之内需要回放时调用 `ring`（参数：起始 seq、结束 seq，含）。
    pub fn attach_with_ring(
        &mut self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
        resume_from_seq: Option<u64>,
        ring: &mut dyn FnMut(u64, u64) -> Option<Vec<u8>>,
    ) -> Result<AttachOutcome, AttachError> {
        self.attach_inner(
            channel_id,
            client_instance_id,
            transport_generation,
            resume_from_seq,
            Some(ring),
        )
    }

    pub fn command_state(&self) -> CommandStateInfo {
        self.terminal.command_state()
    }

    pub fn take_command_change(&mut self) -> Option<CommandStateInfo> {
        self.terminal.take_command_change()
    }

    pub fn take_title_change(&mut self) -> Option<String> {
        self.terminal.take_title_change()
    }

    /// Feed PTY output and return the deltas owed to subscribers. When the output completes a DA1
    /// query that no human client receives raw — no holder, an agent holder, or a holder whose
    /// subscription is gapped or behind — sessiond becomes the answerer: one reply per query is
    /// left for [`SessionState::take_query_replies`] and the answered-query marker moves to the
    /// last such query. A human holder receiving these bytes answers through xterm.js instead.
    /// `feed` itself never writes anything.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<PendingDelta> {
        self.query_replies.clear();
        let Some(delta) = self.terminal.feed(bytes) else {
            return Vec::new();
        };
        let mut pending = Vec::new();
        for (channel_id, subscriber) in &mut self.subscribers {
            if subscriber.gapped {
                continue;
            }
            if subscriber.next_seq != delta.from_seq {
                subscriber.gapped = true;
                subscriber.gap_notified = false;
                continue;
            }
            pending.push(PendingDelta {
                channel_id: channel_id.clone(),
                delta: delta.clone(),
            });
        }
        let queries = self.terminal.take_da1_queries();
        if let Some(&last_query) = queries.last() {
            // Agent channels stay subscribed after their write, so a subscription alone is not an
            // answerer: only the human holder's own raw stream is.
            let human_receives_raw = self.holder.as_ref().is_some_and(|holder| {
                !holder.client_instance_id.starts_with(AGENT_IDENTITY_PREFIX)
                    && pending
                        .iter()
                        .any(|delivery| delivery.channel_id == holder.channel_id)
            });
            if !human_receives_raw {
                self.query_replies = vec![DA1_REPLY.to_vec(); queries.len()];
                self.terminal.raise_answered_query_seq(last_query);
            }
        }
        pending
    }

    /// The replies the last `feed` decided sessiond must write into the PTY, in order. The caller
    /// enqueues them on the session's input writer under the same lock as the `feed`; whatever is
    /// not taken is discarded by the next `feed`.
    pub fn take_query_replies(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.query_replies)
    }

    /// Output seq of the final byte of the last query sessiond answered itself (0 = none).
    pub fn answered_query_seq(&self) -> u64 {
        self.terminal.answered_query_seq()
    }

    /// Carry the answered-query marker over from a state being replaced; it never moves down.
    pub fn raise_answered_query_seq(&mut self, seq: u64) {
        self.terminal.raise_answered_query_seq(seq);
    }

    /// 单测便利：没有 ring 的 attach（生产只走 [`SessionState::attach_with_ring`]，本地重发缓冲之外由 ptyd 的 ring 补）。
    #[cfg(test)]
    pub fn attach(
        &mut self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
        resume_from_seq: Option<u64>,
    ) -> Result<AttachOutcome, AttachError> {
        self.attach_inner(
            channel_id,
            client_instance_id,
            transport_generation,
            resume_from_seq,
            None,
        )
    }

    fn attach_inner(
        &mut self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
        resume_from_seq: Option<u64>,
        mut ring: Option<&mut dyn FnMut(u64, u64) -> Option<Vec<u8>>>,
    ) -> Result<AttachOutcome, AttachError> {
        self.validate_attach(channel_id, client_instance_id, transport_generation)?;
        let mut detached = None;
        let epoch = match &self.holder {
            None => self.bump_holder_epoch(),
            Some(holder) if holder.client_instance_id == client_instance_id => {
                if transport_generation > holder.transport_generation
                    && holder.channel_id != channel_id
                {
                    self.subscribers.remove(&holder.channel_id);
                }
                holder.epoch
            }
            Some(holder) => {
                detached = Some(DetachedTarget {
                    channel_id: holder.channel_id.clone(),
                    holder_epoch: holder.epoch,
                });
                self.subscribers.remove(&holder.channel_id);
                self.bump_holder_epoch()
            }
        };
        self.holder = Some(Holder {
            client_instance_id: client_instance_id.to_string(),
            transport_generation,
            channel_id: channel_id.to_string(),
            epoch,
        });
        self.transport_bindings.insert(
            client_instance_id.to_string(),
            TransportBinding {
                generation: transport_generation,
                channel_id: channel_id.to_string(),
            },
        );

        // A resume below the answered-query marker would hand the client raw bytes containing a
        // query sessiond already answered, and xterm.js would answer it again: snapshot instead.
        let answered_through = self.terminal.answered_query_seq();
        let resume_from_seq = resume_from_seq.filter(|seq| *seq >= answered_through);
        let local = resume_from_seq
            .and_then(|seq| self.terminal.deltas_after(seq).map(|deltas| (seq, deltas)));
        // 本地缓冲够不到、但 ring 仍覆盖：从 ptyd 取 `[seq+1, output_seq]` 一整段当作一条 delta。
        let from_ring = match (&local, resume_from_seq, ring.as_mut()) {
            (None, Some(seq), Some(ring))
                if seq < self.terminal.output_seq()
                    && seq.saturating_add(1) >= self.terminal.ring_floor_seq() =>
            {
                let from = seq.saturating_add(1);
                let to = self.terminal.output_seq();
                ring(from, to)
                    .filter(|data| data.len() as u64 == to - from + 1)
                    .map(|data| {
                        (
                            seq,
                            vec![Delta {
                                from_seq: from,
                                to_seq: to,
                                data,
                            }],
                        )
                    })
            }
            _ => None,
        };
        let (snapshot_seq, ansi_snapshot, replay) = match local.or(from_ring) {
            Some((seq, replay)) => (seq, None, replay),
            None => (
                self.terminal.output_seq(),
                Some(self.terminal.snapshot()),
                Vec::new(),
            ),
        };
        self.subscribers.insert(
            channel_id.to_string(),
            Subscriber {
                next_seq: snapshot_seq.saturating_add(1),
                gapped: false,
                gap_notified: false,
            },
        );
        Ok(AttachOutcome {
            holder_epoch: epoch,
            snapshot_seq,
            ansi_snapshot,
            replay,
            detached,
        })
    }

    pub fn validate_attach(
        &self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
    ) -> Result<(), AttachError> {
        if channel_id.is_empty() || client_instance_id.is_empty() || transport_generation == 0 {
            return Err(AttachError {
                code: "invalid_attach",
                message: "channel/client/generation 必须有效".into(),
            });
        }
        if !self.transport_bindings.contains_key(client_instance_id)
            && self.transport_bindings.len() >= LOGICAL_CLIENT_LIMIT
        {
            return Err(AttachError {
                code: "logical_client_limit",
                message: format!("session logical client identity 已达上限 {LOGICAL_CLIENT_LIMIT}"),
            });
        }
        if let Some(binding) = self.transport_bindings.get(client_instance_id) {
            if transport_generation < binding.generation {
                return Err(AttachError {
                    code: "stale_transport",
                    message: "transport generation 已过期".into(),
                });
            }
            if transport_generation == binding.generation && binding.channel_id != channel_id {
                return Err(AttachError {
                    code: "generation_collision",
                    message: "同一 transport generation 不能绑定不同 channel".into(),
                });
            }
            if transport_generation > binding.generation && binding.channel_id == channel_id {
                return Err(AttachError {
                    code: "generation_collision",
                    message: "更高 transport generation 必须迁移到新的 channel".into(),
                });
            }
        }
        Ok(())
    }

    fn bump_holder_epoch(&mut self) -> u64 {
        self.next_holder_epoch = self.next_holder_epoch.saturating_add(1).max(1);
        self.next_holder_epoch
    }

    pub fn delivery_result(&mut self, channel_id: &str, to_seq: u64, sent: bool) {
        let Some(subscriber) = self.subscribers.get_mut(channel_id) else {
            return;
        };
        if sent && subscriber.next_seq <= to_seq {
            subscriber.next_seq = to_seq.saturating_add(1);
        } else if !sent {
            subscriber.gapped = true;
            subscriber.gap_notified = false;
        }
    }

    pub fn pending_gaps(&self) -> Vec<PendingGap> {
        // gap 里报 ring 起点而不是 512 KB 重发缓冲的上限：resume 能深到 ring 有多深。
        let available_seq = self
            .terminal
            .earliest_retransmit_seq()
            .min(self.terminal.ring_floor_seq());
        self.subscribers
            .iter()
            .filter(|(_, subscriber)| subscriber.gapped && !subscriber.gap_notified)
            .map(|(channel_id, subscriber)| PendingGap {
                channel_id: channel_id.clone(),
                expected_seq: subscriber.next_seq,
                available_seq,
            })
            .collect()
    }

    pub fn gap_delivery_result(&mut self, channel_id: &str, sent: bool) {
        if let Some(subscriber) = self.subscribers.get_mut(channel_id) {
            subscriber.gap_notified = sent;
        }
    }

    pub fn subscriber_channels(&self) -> Vec<String> {
        self.subscribers.keys().cloned().collect()
    }

    /// worker 物理连接重建后旧 channel transport 全部失效；logical holder/epoch 保留，等待同一
    /// client 以更高 generation 迁移，不能把 worker restart 误判成 holder handoff。
    pub fn clear_subscribers(&mut self) {
        self.subscribers.clear();
    }

    pub fn remove_subscriber(&mut self, channel_id: &str) {
        self.subscribers.remove(channel_id);
    }

    fn current_holder(&self, channel_id: &str, holder_epoch: u64) -> Result<&Holder, ControlError> {
        let Some(holder) = &self.holder else {
            return Err(ControlError {
                code: "no_holder",
                message: "session 当前没有 holder".into(),
            });
        };
        if holder.epoch != holder_epoch {
            return Err(ControlError {
                code: "stale_holder",
                message: "holder epoch 已过期".into(),
            });
        }
        if holder.channel_id != channel_id {
            return Err(ControlError {
                code: "stale_transport",
                message: "该 channel 已不是当前 transport".into(),
            });
        }
        Ok(holder)
    }

    pub fn authorize_holder(
        &self,
        channel_id: &str,
        holder_epoch: u64,
    ) -> Result<(), ControlError> {
        self.current_holder(channel_id, holder_epoch).map(|_| ())
    }

    pub fn admit_input(
        &mut self,
        channel_id: &str,
        request_id: &str,
        holder_epoch: u64,
        input_seq: u64,
        data: Vec<u8>,
    ) -> Result<InputAdmission, ControlError> {
        if input_seq == 0 {
            return Err(ControlError {
                code: "invalid_input_seq",
                message: "input sequence 必须从 1 开始".into(),
            });
        }
        let client_instance_id = self
            .current_holder(channel_id, holder_epoch)?
            .client_instance_id
            .clone();
        if let Some(failure) = &self.input_failure {
            return Err(failure.clone());
        }
        if self.cursorless_rebuild
            && !self.input_cursors.contains_key(&client_instance_id)
            && !self
                .input_reservations
                .get(&client_instance_id)
                .is_some_and(|reservations| !reservations.is_empty())
        {
            // 没有游标可对照：以 client 自报的 seq 为起点接纳；它是否重复 / 跳号由 ptyd 的游标在写入时裁决。
            self.input_cursors.insert(
                client_instance_id.clone(),
                InputCursor {
                    seq: input_seq.saturating_sub(1),
                    data: Vec::new(),
                },
            );
        }

        let applied_through_seq = self
            .input_cursors
            .get(&client_instance_id)
            .map_or(0, |cursor| cursor.seq);
        if input_seq <= applied_through_seq {
            if self
                .input_cursors
                .get(&client_instance_id)
                .is_some_and(|cursor| input_seq == cursor.seq && cursor.data != data)
            {
                return Err(ControlError {
                    code: "input_seq_collision",
                    message: "相同 input sequence 携带了不同 payload".into(),
                });
            }
            return Ok(InputAdmission::Duplicate {
                applied_through_seq,
            });
        }

        let reservations = self
            .input_reservations
            .entry(client_instance_id.clone())
            .or_default();
        if let Some(pending) = reservations
            .iter_mut()
            .find(|pending| pending.seq == input_seq)
        {
            if pending.data != data {
                return Err(ControlError {
                    code: "input_seq_collision",
                    message: "相同 input sequence 携带了不同 payload".into(),
                });
            }
            pending.channel_id = channel_id.to_string();
            pending.request_id = request_id.to_string();
            return Ok(InputAdmission::Pending);
        }

        let expected = reservations
            .back()
            .map_or_else(
                || applied_through_seq.checked_add(1),
                |pending| pending.seq.checked_add(1),
            )
            .ok_or_else(|| ControlError {
                code: "input_seq_exhausted",
                message: "input sequence 已耗尽".into(),
            })?;
        if input_seq != expected {
            return Err(ControlError {
                code: "input_seq_gap",
                message: format!("input sequence 不连续，期望 {expected}"),
            });
        }

        reservations.push_back(PendingInput {
            seq: input_seq,
            data,
            channel_id: channel_id.to_string(),
            request_id: request_id.to_string(),
        });
        Ok(InputAdmission::Enqueue { client_instance_id })
    }

    #[cfg(test)]
    pub fn input_applied_through(
        &self,
        channel_id: &str,
        holder_epoch: u64,
    ) -> Result<u64, ControlError> {
        let holder = self.current_holder(channel_id, holder_epoch)?;
        Ok(self
            .input_cursors
            .get(&holder.client_instance_id)
            .map_or(0, |cursor| cursor.seq))
    }

    /// bounded writer queue 拒绝时回滚刚做出的最后一个 reservation。调用方仍持 session
    /// mutex，所以 writer 最多已经取走 command 并等待同一把锁，不会抢先完成。
    pub fn cancel_input_reservation(&mut self, client_instance_id: &str, input_seq: u64) -> bool {
        let Some(reservations) = self.input_reservations.get_mut(client_instance_id) else {
            return false;
        };
        if reservations
            .back()
            .is_none_or(|pending| pending.seq != input_seq)
        {
            return false;
        }
        reservations.pop_back();
        if reservations.is_empty() {
            self.input_reservations.remove(client_instance_id);
        }
        true
    }

    /// writer 完整写完后提交 reservation。这里按 logical client 而不是当前 holder 提交：
    /// takeover 不能把已经通过旧 authority 裁决、正在 PTY 中执行的输入变成可重放输入。
    pub fn complete_input(
        &mut self,
        client_instance_id: &str,
        input_seq: u64,
    ) -> Result<InputCompletion, ControlError> {
        debug_assert!(
            self.transport_bindings.contains_key(client_instance_id),
            "input cursor 只能属于 attach 已准入的 logical identity"
        );
        if let Some(failure) = &self.input_failure {
            return Err(failure.clone());
        }
        let applied_through = self
            .input_cursors
            .get(client_instance_id)
            .map_or(0, |cursor| cursor.seq);
        let Some(expected) = applied_through.checked_add(1) else {
            return Err(ControlError {
                code: "input_seq_exhausted",
                message: "input sequence 已耗尽".into(),
            });
        };
        if input_seq != expected {
            return Err(ControlError {
                code: "input_commit_out_of_order",
                message: format!("input commit 不连续，期望 {expected}"),
            });
        }
        let pending = {
            let Some(reservations) = self.input_reservations.get_mut(client_instance_id) else {
                return Err(ControlError {
                    code: "input_reservation_missing",
                    message: "input reservation 不存在".into(),
                });
            };
            if reservations
                .front()
                .is_none_or(|pending| pending.seq != input_seq)
            {
                return Err(ControlError {
                    code: "input_commit_out_of_order",
                    message: "input writer completion 顺序错误".into(),
                });
            }
            reservations.pop_front().unwrap()
        };
        if self
            .input_reservations
            .get(client_instance_id)
            .is_some_and(VecDeque::is_empty)
        {
            self.input_reservations.remove(client_instance_id);
        }
        self.input_cursors.insert(
            client_instance_id.to_string(),
            InputCursor {
                seq: input_seq,
                data: pending.data,
            },
        );
        Ok(InputCompletion {
            channel_id: pending.channel_id,
            applied_through_seq: input_seq,
        })
    }

    /// 任何 PTY write error 都使 byte-stream 原子性不可再证明。尤其 partial write 已把前缀
    /// 交给子进程，绝不能释放 reservation 让客户端全量重投；封死 session input，随后由
    /// sessions 层 kill child，使这条损坏的流确定终止。
    pub fn fail_input(
        &mut self,
        client_instance_id: &str,
        input_seq: u64,
        code: &'static str,
        message: String,
    ) -> Result<InputFailureTarget, ControlError> {
        let pending = self
            .input_reservations
            .get(client_instance_id)
            .and_then(|reservations| reservations.front())
            .filter(|pending| pending.seq == input_seq)
            .ok_or_else(|| ControlError {
                code: "input_reservation_missing",
                message: "input reservation 不存在".into(),
            })?;
        let target = InputFailureTarget {
            channel_id: pending.channel_id.clone(),
            request_id: pending.request_id.clone(),
        };
        self.input_failure = Some(ControlError { code, message });
        Ok(target)
    }

    pub fn resize_decision(
        &self,
        channel_id: &str,
        holder_epoch: u64,
        resize_seq: u64,
        rows: u16,
        cols: u16,
    ) -> Result<SequencedDecision, ControlError> {
        if resize_seq == 0 {
            return Err(ControlError {
                code: "invalid_resize_seq",
                message: "resize sequence 必须从 1 开始".into(),
            });
        }
        let holder = self.current_holder(channel_id, holder_epoch)?;
        match self.resize_cursors.get(&holder.client_instance_id) {
            None => Ok(SequencedDecision::Apply),
            Some(cursor) if resize_seq > cursor.seq => Ok(SequencedDecision::Apply),
            Some(cursor)
                if resize_seq == cursor.seq && cursor.rows == rows && cursor.cols == cols =>
            {
                Ok(SequencedDecision::Duplicate)
            }
            Some(cursor) if resize_seq == cursor.seq => Err(ControlError {
                code: "resize_seq_collision",
                message: "相同 resize sequence 携带了不同尺寸".into(),
            }),
            Some(_) => Err(ControlError {
                code: "stale_resize",
                message: "resize sequence 已过期".into(),
            }),
        }
    }

    pub fn commit_resize(
        &mut self,
        channel_id: &str,
        holder_epoch: u64,
        resize_seq: u64,
        rows: u16,
        cols: u16,
    ) -> Result<(), ControlError> {
        let client_instance_id = self
            .current_holder(channel_id, holder_epoch)?
            .client_instance_id
            .clone();
        debug_assert!(
            self.transport_bindings.contains_key(&client_instance_id),
            "resize cursor 只能属于 attach 已准入的 logical identity"
        );
        self.resize_cursors.insert(
            client_instance_id,
            ResizeCursor {
                seq: resize_seq,
                rows,
                cols,
            },
        );
        Ok(())
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.terminal.resize(rows, cols);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.terminal.snapshot()
    }

    pub fn output_seq(&self) -> u64 {
        self.terminal.output_seq()
    }

    pub fn title(&self) -> &str {
        self.terminal.title()
    }

    pub fn rows(&self) -> u16 {
        self.terminal.rows()
    }

    pub fn cols(&self) -> u16 {
        self.terminal.cols()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
    use libghostty_vt::key;
    use libghostty_vt::screen::{CellWide, Screen};
    use libghostty_vt::style::{RgbColor, Style, StyleColor, Underline};
    use libghostty_vt::terminal::{Mode, ModeKind, Point, PointCoordinate};
    use libghostty_vt::{RenderState, Terminal};

    type Term = vt::Term;

    /// A fresh libghostty terminal of the given size with `bytes` written into it: what a client
    /// replaying a snapshot ends up with. Its scrollback is unlimited so nothing replayed is lost.
    fn replay(rows: u16, cols: u16, bytes: &[u8]) -> Term {
        let mut term: Term = Terminal::new(cols, rows).unwrap();
        term.set_scrollback_max_bytes(None).unwrap();
        term.vt_write(bytes);
        term
    }

    fn restored(state: &TerminalState) -> Term {
        replay(state.rows, state.cols, &state.snapshot())
    }

    /// The oracle: the same output written into a terminal configured exactly like sessiond's,
    /// on the test thread, so its state can be read directly.
    struct Reference {
        engine: vt::Engine,
        scanner: OutputScanner,
    }

    impl Reference {
        fn new(rows: u16, cols: u16, history_line_limit: usize) -> Self {
            Self {
                engine: vt::Engine::new(rows, cols, history_line_limit).unwrap(),
                scanner: OutputScanner::default(),
            }
        }

        fn feed(&mut self, bytes: &[u8]) {
            let mut resets = Vec::new();
            for (index, byte) in bytes.iter().enumerate() {
                if self.scanner.feed(*byte) == Some(ScanEvent::GraphemeClusterSet) {
                    resets.push(index);
                }
            }
            self.engine.write(bytes, &resets);
        }

        fn resize(&mut self, rows: u16, cols: u16) {
            self.engine.resize(rows, cols);
        }

        fn term(&self) -> &Term {
            self.engine.terminal()
        }
    }

    #[derive(Debug, PartialEq)]
    struct CellDump {
        text: String,
        wide: CellWide,
        style: Style,
        link: Vec<u8>,
    }

    #[derive(Debug, PartialEq)]
    struct RowDump {
        wrapped: bool,
        continuation: bool,
        cells: Vec<CellDump>,
    }

    impl RowDump {
        fn text(&self) -> String {
            self.cells
                .iter()
                .map(|cell| {
                    if cell.text.is_empty() && cell.wide != CellWide::SpacerTail {
                        " ".to_string()
                    } else {
                        cell.text.clone()
                    }
                })
                .collect::<String>()
                .trim_end()
                .to_string()
        }
    }

    fn cell_dump(term: &Term, x: u16, y: u32) -> CellDump {
        let grid = term
            .grid_ref(Point::Screen(PointCoordinate { x, y }))
            .unwrap();
        let mut graphemes = ['\0'; 32];
        let len = grid.graphemes(&mut graphemes).unwrap();
        let mut link = vec![0u8; 2048];
        let link_len = grid.hyperlink_uri(&mut link).unwrap();
        link.truncate(link_len);
        CellDump {
            text: graphemes[..len].iter().collect(),
            wide: grid.cell().unwrap().wide().unwrap(),
            style: grid.style().unwrap(),
            link,
        }
    }

    /// Every row, scrollback first.
    fn rows_dump(term: &Term) -> Vec<RowDump> {
        let cols = term.cols().unwrap();
        let total = term.total_rows().unwrap() as u32;
        (0..total)
            .map(|y| {
                let row = term
                    .grid_ref(Point::Screen(PointCoordinate { x: 0, y }))
                    .unwrap()
                    .row()
                    .unwrap();
                RowDump {
                    wrapped: row.is_wrapped().unwrap(),
                    continuation: row.is_wrap_continuation().unwrap(),
                    cells: (0..cols).map(|x| cell_dump(term, x, y)).collect(),
                }
            })
            .collect()
    }

    const MODES: &[Mode] = &[
        Mode::INSERT,
        Mode::LINEFEED,
        Mode::DECCKM,
        Mode::ORIGIN,
        Mode::WRAPAROUND,
        Mode::CURSOR_BLINKING,
        Mode::CURSOR_VISIBLE,
        Mode::ALT_SCREEN_LEGACY,
        Mode::KEYPAD_KEYS,
        Mode::LEFT_RIGHT_MARGIN,
        Mode::X10_MOUSE,
        Mode::NORMAL_MOUSE,
        Mode::BUTTON_MOUSE,
        Mode::ANY_MOUSE,
        Mode::FOCUS_EVENT,
        Mode::SGR_MOUSE,
        Mode::ALT_SCREEN,
        Mode::ALT_SCREEN_SAVE,
        Mode::BRACKETED_PASTE,
        Mode::SYNC_OUTPUT,
        Mode::GRAPHEME_CLUSTER,
        Mode::IN_BAND_RESIZE,
    ];

    /// Cursor, pen, keyboard flags, modes and cursor shape: everything a snapshot must carry
    /// besides the cells.
    #[derive(Debug, PartialEq)]
    struct StateDump {
        cursor: (u16, u16),
        pending_wrap: bool,
        cursor_visible: bool,
        pen: Style,
        kitty_flags: u8,
        modes: Vec<(u16, bool, bool)>,
        screen: Screen,
        cursor_shape: String,
        cursor_blinking: bool,
    }

    fn state_dump(term: &Term) -> StateDump {
        let mut render = RenderState::new().unwrap();
        let snapshot = render.update(term).unwrap();
        StateDump {
            cursor: (term.cursor_x().unwrap(), term.cursor_y().unwrap()),
            pending_wrap: term.is_cursor_pending_wrap().unwrap(),
            cursor_visible: term.is_cursor_visible().unwrap(),
            pen: term.cursor_style().unwrap(),
            kitty_flags: term.kitty_keyboard_flags().unwrap().bits(),
            modes: MODES
                .iter()
                .map(|mode| {
                    (
                        mode.value(),
                        mode.kind() == ModeKind::Ansi,
                        term.mode(*mode).unwrap(),
                    )
                })
                .collect(),
            screen: term.active_screen().unwrap(),
            cursor_shape: format!("{:?}", snapshot.cursor_visual_style().unwrap()),
            cursor_blinking: snapshot.cursor_blinking().unwrap(),
        }
    }

    /// `actual` (a replayed snapshot) shows what `expected` shows: the same screen, the same
    /// newest history rows (a snapshot carries at most `history_line_limit` logical lines, the
    /// reference may keep more), the same cursor, pen, modes and keyboard state.
    fn assert_equivalent(actual: &Term, expected: &Term) {
        let actual_rows = rows_dump(actual);
        let expected_rows = rows_dump(expected);
        let actual_history = actual.scrollback_rows().unwrap();
        let expected_history = expected.scrollback_rows().unwrap();
        assert!(
            expected_history >= actual_history,
            "the replay holds more history ({actual_history}) than the terminal ({expected_history})"
        );
        assert_eq!(
            actual_rows[..],
            expected_rows[expected_history - actual_history..],
            "rows differ"
        );
        assert_eq!(state_dump(actual), state_dump(expected), "state differs");
    }

    /// The text of the whole terminal, history included, soft-wrapped lines joined.
    fn plain_text(term: &Term) -> String {
        let options = FormatterOptions::new()
            .with_format(Format::Plain)
            .with_unwrap(true);
        let mut formatter = Formatter::new(term, options).unwrap();
        String::from_utf8(formatter.format_alloc(None).unwrap().to_vec()).unwrap()
    }

    /// What the key encoder sends for a few keys under the terminal's keyboard state (cursor
    /// keys, keypad, modifyOtherKeys, Kitty flags).
    fn key_probe(term: &Term) -> Vec<Vec<u8>> {
        let mut encoder = key::Encoder::new().unwrap();
        encoder.set_options_from_terminal(term);
        [
            (key::Key::Enter, key::Mods::CTRL, None),
            (key::Key::ArrowUp, key::Mods::empty(), None),
            (key::Key::I, key::Mods::CTRL, Some("i")),
            (key::Key::A, key::Mods::CTRL | key::Mods::SHIFT, Some("a")),
        ]
        .into_iter()
        .map(|(code, mods, text)| {
            let mut event = key::Event::new().unwrap();
            event
                .set_action(key::Action::Press)
                .set_key(code)
                .set_mods(mods);
            event.set_utf8(text);
            let mut out = Vec::new();
            encoder.encode_to_vec(&event, &mut out).unwrap();
            out
        })
        .collect()
    }

    #[test]
    fn sessiond_vt_snapshot_restores_unicode_color_cursor_and_modes() {
        let bytes = concat!(
            "plain\r\n",
            "\x1b[38;2;12;34;56m真e\u{301}\x1b[48;5;201m彩色\x1b[0m\r\n",
            "third line\x1b[3DXYZ",
            "\x1b[?2004h\x1b[?1h\x1b[?25l"
        )
        .as_bytes();
        let mut state = TerminalState::new(5, 24, 16);
        let mut reference = Reference::new(5, 24, 16);
        state.feed(bytes);
        reference.feed(bytes);
        state.resize(6, 30);
        reference.resize(6, 30);
        state.feed(b"\r\nafter resize");
        reference.feed(b"\r\nafter resize");
        assert_equivalent(&restored(&state), reference.term());
    }

    #[test]
    fn sessiond_vt_chunk_boundaries_do_not_change_snapshot() {
        let bytes = b"before\r\n\x1b[31mred\x1b[0m\x1b[2D!\x1b[?2004h";
        let mut whole = TerminalState::new(4, 12, 8);
        whole.feed(bytes);
        let mut split = TerminalState::new(4, 12, 8);
        for byte in bytes {
            split.feed(std::slice::from_ref(byte));
        }
        assert_eq!(whole.snapshot(), split.snapshot());
    }

    /// Writes `stream` one byte at a time into the scanner and into a libghostty terminal: after
    /// every byte, "between sequences" must be libghostty's own ground state.
    fn assert_boundaries_match_libghostty(stream: &[u8]) {
        let mut scanner = OutputScanner::default();
        let mut term: Term = Terminal::new(20, 4).unwrap();
        for (index, byte) in stream.iter().enumerate() {
            scanner.feed(*byte);
            term.vt_write(std::slice::from_ref(byte));
            assert_eq!(
                scanner.between_sequences(),
                term.is_vt_ground().unwrap(),
                "after byte {index} ({byte:#04x}) of {stream:?}"
            );
        }
    }

    #[test]
    fn scanner_sequence_boundaries_follow_libghostty() {
        let mut streams: Vec<Vec<u8>> = vec![
            b"plain \x1b[1;31mred\x1b[0m \x1b[?1049h\x1b[?47l".to_vec(),
            b"\x1b]0;title\x07\x1b]2;st\x1b\\\x1b]133;A;coflux=x\x07".to_vec(),
            b"\x1bPq#0;2;0;0;0#0~~\x1b\\\x1b_Gf=100;\x1b\\\x1b^pm\x1b\\\x1bXsos\x1b\\".to_vec(),
            "真e\u{301} 😀 ok".as_bytes().to_vec(),
            // ESC inside a UTF-8 character starts a sequence.
            vec![0xe7, 0x1b, b'[', b'm', b'x'],
            // CSI shapes libghostty ignores but still ends at the final byte.
            b"\x1b[:c\x1b[1:2m\x1b[1:2H\x1b[0;?c\x1b[ 0c\x1b[1\x7f2m\x1b[1\x072m".to_vec(),
            // 0xA0-0xFF inside escape and CSI states are ignored, not printed.
            b"\x1b\xa0A\x1b[1\xff2m\x1b(\xe0B".to_vec(),
            // C1 bytes inside sequences start or end them, but are payload in OSC and DCS bodies.
            b"\x1b[1\x9b2c\x1b[\x9d0;t\x07\x1b\x80x\x1b[\x9cq".to_vec(),
            b"\x1b]0;a\x9cb\x9bc\x07\x1bP1;2|pay\x9cload\x1b\\\x1bP\x9b5m".to_vec(),
            b"\x1b_apc\x9cafter\x1b_apc\xa0\xff\x1b\\\x1bX\x90q\x1b\\".to_vec(),
            // DCS entry, parameter and intermediate states.
            b"\x1bP:x\x1b\\\x1bP1;2 !q\x1b\\\x1bP1?q\x1b\\\x1bP !0q\x1b\\".to_vec(),
        ];
        for control in [0x18u8, 0x1a] {
            for prefix in [
                &b"\x1b"[..],
                b"\x1b[?1049",
                b"\x1b]0;t",
                b"\x1bPq",
                b"\x1b_G",
                b"\x1b (",
            ] {
                let mut stream = prefix.to_vec();
                stream.push(control);
                stream.extend_from_slice(b"h after\x1b[0m");
                streams.push(stream);
            }
        }
        for control in [0x00u8, 0x07, 0x17, 0x19, 0x1c, 0x1f, 0x7f, 0x80] {
            streams.push([&b"\x1b"[..], &[control], b"[?1049h", b"\x1b[?47l"].concat());
        }
        for intermediate in 0x20u8..=0x2f {
            streams.push([&b"\x1b"[..], &[intermediate], b"[?1049h"].concat());
            streams.push([&b"\x1b[?1049"[..], &[intermediate], b"1h", b"\x1b[?47l"].concat());
            streams.push([&b"\x1b["[..], &[intermediate], b"?1049h"].concat());
        }
        for marker in 0x3cu8..=0x3f {
            streams.push([&b"\x1b[?"[..], &[marker], b"1049h"].concat());
        }
        let mut long = b"\x1b[?".to_vec();
        long.extend(std::iter::repeat_n(b';', 10_000));
        long.extend_from_slice(b"1049h done");
        streams.push(long);
        for stream in &streams {
            assert_boundaries_match_libghostty(stream);
        }
    }

    #[test]
    fn sessiond_title_change_fires_once_per_real_change() {
        let mut state = TerminalState::new(4, 12, 8);
        assert_eq!(state.take_title_change(), None);
        state.feed(b"\x1b]0;one\x07");
        assert_eq!(state.take_title_change().as_deref(), Some("one"));
        assert_eq!(state.take_title_change(), None, "taken once");
        state.feed(b"plain output\x1b]2;one\x07");
        assert_eq!(
            state.take_title_change(),
            None,
            "the same title again is not a change"
        );
        state.feed(b"\x1b]2;two\x07\x1b]2;\x07");
        assert_eq!(
            state.take_title_change().as_deref(),
            Some(""),
            "the last title of a chunk wins"
        );
    }

    #[test]
    fn sessiond_title_captures_osc_0_and_2_including_explicit_clear() {
        let mut state = TerminalState::new(4, 12, 8);
        assert_eq!(state.title(), "");
        state.feed(b"\x1b]0;from osc 0\x07");
        assert_eq!(state.title(), "from osc 0");
        state.feed(b"\x1b]2;from osc 2\x1b\\"); // ST 结尾同样合法
        assert_eq!(state.title(), "from osc 2");
        state.feed(b"plain output does not touch title");
        assert_eq!(state.title(), "from osc 2");
        state.feed(b"\x1b]0;\x07"); // 显式设空 = 清空
        assert_eq!(state.title(), "");
        // Not titles: another OSC, a title with a separator, an aborted OSC.
        state.feed(b"\x1b]1;icon\x07\x1b]2;a;b\x07\x1b]2;cancelled\x18");
        assert_eq!(state.title(), "");
    }

    #[test]
    fn sessiond_title_survives_chunked_feed_and_resize() {
        let bytes = "\x1b]0;标题跨 chunk 不碎\x07".as_bytes();
        let mut state = TerminalState::new(4, 12, 8);
        for byte in bytes {
            state.feed(std::slice::from_ref(byte));
        }
        assert_eq!(state.title(), "标题跨 chunk 不碎");
        state.resize(6, 20);
        assert_eq!(state.title(), "标题跨 chunk 不碎");
    }

    #[test]
    fn sessiond_title_clamps_length_and_strips_control_bytes() {
        let mut state = TerminalState::new(4, 12, 8);
        let long = format!("\x1b]2;{}\x07", "标".repeat(200)); // 600 bytes UTF-8
        state.feed(long.as_bytes());
        assert!(state.title().len() <= MAX_TITLE_BYTES);
        assert!(state.title().chars().all(|c| c == '标'));
        state.feed(b"\x1b]2;tab\there\x07");
        assert_eq!(state.title(), "tabhere");
        // Past the capture buffer the title still comes from its first bytes.
        let huge = format!("\x1b]2;{}\x07", "t".repeat(OSC_CAPTURE_BYTES * 2));
        state.feed(huge.as_bytes());
        assert_eq!(state.title(), "t".repeat(MAX_TITLE_BYTES));
    }

    #[test]
    fn title_and_marks_are_the_same_whatever_byte_the_stream_is_split_at() {
        let stream = concat!(
            "\x1b]2;split title\x07$ ",
            "\x1b]133;A;coflux=s3cret\x07$ \x1b]133;C;coflux=s3cret\x1b\\",
            "out\x1b]133;D;5;coflux=s3cret\x07\x1b]0;最后\x1b\\"
        )
        .as_bytes();
        let mut whole = TerminalState::new(4, 40, 8).with_mark_secret("s3cret".into());
        whole.feed(stream);
        assert_eq!(whole.title(), "最后");
        assert_eq!(whole.command_state().exit_code, Some(5));
        for cut in 0..=stream.len() {
            let mut split = TerminalState::new(4, 40, 8).with_mark_secret("s3cret".into());
            split.feed(&stream[..cut]);
            split.feed(&stream[cut..]);
            assert_eq!(split.title(), whole.title(), "cut {cut}");
            assert_eq!(split.command_state(), whole.command_state(), "cut {cut}");
        }
    }

    #[test]
    fn sessiond_marks_drive_command_state_only_with_the_session_secret() {
        let mut state = TerminalState::new(4, 40, 8).with_mark_secret("s3cret".into());
        assert_eq!(state.command_state(), CommandStateInfo::default());
        assert!(state.take_command_change().is_none());

        // A prompt framework's bare OSC 133 (no secret): ignored, nothing is "integrated".
        state.feed(b"\x1b]133;A\x07\x1b]133;D;0\x07plain$ ");
        assert!(!state.command_state().integrated);
        assert!(state.take_command_change().is_none());

        // coflux's own prompt-start: integrated and idle, still no command.
        state.feed(b"\x1b]133;A;coflux=s3cret\x07$ ");
        let idle = state
            .take_command_change()
            .expect("prompt mark changes the state");
        assert!(idle.integrated && !idle.busy);
        assert_eq!(
            (idle.command_seq, idle.finished_seq, idle.exit_code),
            (0, 0, None)
        );
        // A second prompt (empty Enter) changes nothing and pushes nothing.
        state.feed(b"\x1b]133;A;coflux=s3cret\x07$ ");
        assert!(state.take_command_change().is_none());

        // command-start: busy with sequence 1.
        state.feed(b"ssh host\r\n\x1b]133;C;coflux=s3cret\x07");
        let busy = state.take_command_change().unwrap();
        assert!(busy.busy);
        assert_eq!(busy.command_seq, 1);

        // Marks from the remote host / a nested shell never end the command: bare ones and ones
        // with a foreign secret alike (the secret never crossed the ssh boundary).
        state.feed(b"\x1b]133;A\x07remote$ \x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A;aid=42\x07");
        state.feed(b"\x1b]133;D;0;coflux=other\x07\x1b]133;A;coflux=\x07");
        assert!(state.command_state().busy);
        assert!(state.take_command_change().is_none());

        // command-end with the exit status, delivered one byte at a time (chunked PTY reads).
        for byte in b"\x1b]133;D;3;coflux=s3cret\x07\x1b]133;A;coflux=s3cret\x07$ " {
            state.feed(std::slice::from_ref(byte));
        }
        let done = state.take_command_change().unwrap();
        assert!(!done.busy);
        assert_eq!(
            (done.command_seq, done.finished_seq, done.exit_code),
            (1, 1, Some(3))
        );

        // Without a secret installed nothing is ever accepted — not even an empty `coflux=`.
        let mut plain = TerminalState::new(4, 40, 8);
        plain.feed(b"\x1b]133;A;coflux=\x07\x1b]133;C;coflux=\x07");
        assert_eq!(plain.command_state(), CommandStateInfo::default());
    }

    #[test]
    fn sessiond_command_state_survives_resize_and_tolerates_lost_marks() {
        let mut state = TerminalState::new(4, 40, 8).with_mark_secret("s3cret".into());
        state.feed(b"\x1b]133;A;coflux=s3cret\x07$ \x1b]133;C;coflux=s3cret\x07");
        assert!(state.command_state().busy);
        // resize: the tracker, the secret and busy-ness all survive.
        state.resize(6, 60);
        assert!(state.command_state().busy);
        state.feed(b"\x1b]133;D;0;coflux=s3cret\x07");
        assert_eq!(state.command_state().exit_code, Some(0));
        assert_eq!(state.command_state().finished_seq, 1);

        // A prompt while still busy (exec'd shell, skipped hook): the command closes with an
        // unknown status instead of pinning the terminal busy forever.
        state.feed(b"\x1b]133;C;coflux=s3cret\x07");
        assert_eq!(state.command_state().command_seq, 2);
        state.feed(b"\x1b]133;A;coflux=s3cret\x07$ ");
        let closed = state.command_state();
        assert!(!closed.busy);
        assert_eq!((closed.finished_seq, closed.exit_code), (2, None));

        // An end without a start still counts as one command so promised sequences line up.
        state.feed(b"\x1b]133;D;7;coflux=s3cret\x07");
        let counted = state.command_state();
        assert_eq!(
            (counted.command_seq, counted.finished_seq, counted.exit_code),
            (3, 3, Some(7))
        );

        // A `D` without a status: finished, exit unknown.
        state.feed(b"\x1b]133;C;coflux=s3cret\x07\x1b]133;D;coflux=s3cret\x07");
        let unknown = state.command_state();
        assert_eq!(
            (unknown.command_seq, unknown.finished_seq, unknown.exit_code),
            (4, 4, None)
        );
        // The marks themselves never reach the rendered screen or the title.
        assert_eq!(state.title(), "");
        let snapshot = String::from_utf8_lossy(&state.snapshot()).into_owned();
        assert!(
            !snapshot.contains("s3cret"),
            "secret leaked into the snapshot: {snapshot}"
        );
    }

    #[test]
    fn sessiond_vt_alt_screen_snapshot_restores_hidden_normal_screen() {
        let mut state = TerminalState::new(4, 18, 8);
        let mut reference = Reference::new(4, 18, 8);
        for bytes in [
            &b"normal survives\r\nsecond"[..],
            b"\x1b[?1049h\x1b[2J\x1b[Halt tui\x1b[?2004h",
        ] {
            state.feed(bytes);
            reference.feed(bytes);
        }
        assert_eq!(reference.term().active_screen().unwrap(), Screen::Alternate);

        let snapshot = state.snapshot();
        let primary_end = snapshot
            .windows(b"\x1b[?1049h\x1b[H\x1b[2J".len())
            .position(|window| window == b"\x1b[?1049h\x1b[H\x1b[2J")
            .expect("the alternate half follows the primary snapshot");
        assert!(snapshot.starts_with(b"\x1bc"));
        assert!(
            !String::from_utf8_lossy(&snapshot[..primary_end]).contains("1049"),
            "the primary half must not enter the alternate screen"
        );

        let mut replayed = replay(4, 18, &snapshot);
        assert_equivalent(&replayed, reference.term());
        replayed.vt_write(b"\x1b[?1049l");
        reference.feed(b"\x1b[?1049l");
        assert_equivalent(&replayed, reference.term());
        assert!(plain_text(&replayed).contains("normal survives"));
    }

    #[test]
    fn alternate_screen_snapshot_leaves_the_live_cursor_pen_and_open_link_alone() {
        let mut state = TerminalState::new(4, 20, 8);
        let mut reference = Reference::new(4, 20, 8);
        let setup = b"\x1b[1;32mprimary\r\n\x1b[?1049h\x1b[2J\x1b[2;3H\x1b[3;35m\x1b]8;;https://alt.example/\x1b\\AB";
        state.feed(setup);
        reference.feed(setup);
        let first = state.snapshot();
        assert_eq!(state.snapshot(), first, "taking a snapshot changes nothing");

        // Output after the snapshots continues with the alternate screen's cursor, pen and link.
        let tail = b"CD\x1b]8;;\x1b\\EF";
        state.feed(tail);
        reference.feed(tail);
        let replayed = restored(&state);
        assert_equivalent(&replayed, reference.term());
        let history = replayed.scrollback_rows().unwrap() as u32;
        let cell = cell_dump(&replayed, 4, history + 1);
        assert_eq!(cell.text, "C");
        assert!(cell.style.italic);
        assert_eq!(cell.link, b"https://alt.example/");
        assert!(cell_dump(&replayed, 6, history + 1).link.is_empty());
    }

    #[test]
    fn sessiond_vt_resize_snapshot_matches_the_reflowed_terminal() {
        let mut state = TerminalState::new(2, 8, 8);
        let mut reference = Reference::new(2, 8, 8);
        let bytes = b"first\r\n\x1b[48;5;24m1234567890\x1b[0m";
        state.feed(bytes);
        reference.feed(bytes);
        state.resize(3, 10);
        reference.resize(3, 10);
        assert_equivalent(&restored(&state), reference.term());
        assert!(plain_text(&restored(&state)).contains("1234567890"));
    }

    /// A soft-wrapped row that fills the width exactly, then a continuation row that begins with
    /// empty cells: the replay must wrap there instead of stepping over or erasing the row's last
    /// cell, with or without a background on the empty cells and with or without text after them.
    #[test]
    fn a_full_width_soft_wrap_survives_whatever_the_continuation_row_starts_with() {
        for bytes in [
            &b"1234567890x\x1b[2;1H\x1b[44m\x1b[3X\x1b[0m\x1b[2;6Hy"[..],
            b"1234567890x\x1b[2;1H\x1b[1X\x1b[2;4Hy",
            b"1234567890x\x1b[2;1H\x1b[1;31m\x1b[44m\x1b[2X\x1b[2;3Hz",
            b"\x1b]8;;https://example.com/\x1b\\1234567890x\x1b[2;1H\x1b[45m\x1b[X\x1b[2;4Hw",
        ] {
            let mut state = TerminalState::new(4, 10, 8);
            let mut reference = Reference::new(4, 10, 8);
            state.feed(bytes);
            reference.feed(bytes);
            let replayed = restored(&state);
            assert_equivalent(&replayed, reference.term());
            let rows = rows_dump(&replayed);
            assert!(rows[0].wrapped && rows[1].continuation, "{bytes:?}");
            assert_eq!(rows[0].text(), "1234567890", "{bytes:?}");
        }
    }

    #[test]
    fn resize_reflows_a_long_wrapped_line_on_the_primary_screen() {
        let line = "abcdefghijklmnopqrstuvwxy";
        let mut state = TerminalState::new(4, 10, 8);
        state.feed(format!("{line}\r\nnext").as_bytes());
        let narrow = rows_dump(&restored(&state));
        assert!(
            narrow.iter().any(|row| row.wrapped),
            "25 columns wrap at 10"
        );

        state.resize(4, 30);
        let replayed = restored(&state);
        let rows = rows_dump(&replayed);
        let joined = rows
            .iter()
            .position(|row| row.text() == line)
            .expect("the line is one row again at 30 columns");
        assert!(!rows[joined].wrapped);
        assert_eq!(rows[joined + 1].text(), "next");
        assert!(rows.iter().all(|row| !row.wrapped && !row.continuation));
    }

    #[test]
    fn sessiond_vt_resize_while_alt_reflows_hidden_normal_screen() {
        let mut state = TerminalState::new(2, 8, 8);
        let mut reference = Reference::new(2, 8, 8);
        for bytes in [
            &b"first\r\n\x1b[48;5;24m1234567890\x1b[0m"[..],
            b"\x1b[?1049h\x1b[2J\x1b[Halt tui",
        ] {
            state.feed(bytes);
            reference.feed(bytes);
        }
        state.resize(3, 10);
        reference.resize(3, 10);

        let mut replayed = restored(&state);
        assert_eq!(replayed.active_screen().unwrap(), Screen::Alternate);
        assert_equivalent(&replayed, reference.term());

        replayed.vt_write(b"\x1b[?1049l");
        reference.feed(b"\x1b[?1049l");
        assert_equivalent(&replayed, reference.term());
        assert!(plain_text(&replayed).contains("1234567890"));
    }

    #[test]
    fn sessiond_vt_history_snapshot_keeps_complete_logical_lines() {
        let mut bytes = vec![b'x'; 100];
        bytes.extend_from_slice(b"\r\none\r\ntwo\r\nthree\r\ncurrent");
        for (limit, x_cells) in [(1, 0), (2, 100), (5, 100)] {
            let mut state = TerminalState::new(3, 10, limit);
            state.feed(&bytes);
            let snapshot = state.snapshot();
            assert!(
                snapshot.starts_with(b"\x1bc"),
                "a snapshot starts with a full reset"
            );
            let replayed = replay(3, 10, &snapshot);
            let rows = rows_dump(&replayed);
            let history = replayed.scrollback_rows().unwrap();
            let logical = rows[..history]
                .iter()
                .filter(|row| !row.continuation)
                .count();
            assert!(
                logical <= limit,
                "limit {limit}: {logical} logical lines of history"
            );
            assert!(
                !rows[0].continuation,
                "limit {limit}: history began inside a logical line"
            );
            assert!(
                history == 0 || !rows[history - 1].wrapped,
                "limit {limit}: history ended inside a logical line"
            );
            let text = plain_text(&replayed);
            assert_eq!(
                text.matches('x').count(),
                x_cells,
                "limit {limit}: {text:?}"
            );
            assert!(text.contains("current"));
        }

        let mut none = TerminalState::new(3, 10, 0);
        none.feed(&bytes);
        let replayed = replay(3, 10, &none.snapshot());
        assert_eq!(
            replayed.scrollback_rows().unwrap(),
            0,
            "a zero limit keeps no history"
        );
        assert!(plain_text(&replayed).contains("current"));
    }

    #[test]
    fn snapshot_carries_full_sgr_links_scroll_region_and_keyboard_modes() {
        let bytes = concat!(
            "\x1b[9mstrike\x1b[0m \x1b[4:3;58:2::255:0:128mcurly\x1b[0m ",
            "\x1b]8;id=x;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ ",
            "\x1b[5;38;5;208;48;2;1;2;3mblink\x1b[0m\r\n",
            "\x1b[3;8r\x1b[>4;2m\x1b[>1u\x1b[?1h\x1b=\x1b[3g\x1b[1;5H\x1bH\x1b[5;2H"
        )
        .as_bytes();
        let mut state = TerminalState::new(10, 40, 16);
        let mut reference = Reference::new(10, 40, 16);
        state.feed(bytes);
        reference.feed(bytes);
        let mut replayed = restored(&state);
        assert_equivalent(&replayed, reference.term());

        let history = replayed.scrollback_rows().unwrap() as u32;
        assert!(cell_dump(&replayed, 0, history).style.strikethrough);
        let curly = cell_dump(&replayed, 7, history);
        assert_eq!(curly.style.underline, Underline::Curly);
        assert_eq!(
            curly.style.underline_color,
            StyleColor::Rgb(RgbColor {
                r: 255,
                g: 0,
                b: 128
            })
        );
        assert_eq!(
            cell_dump(&replayed, 13, history).link,
            b"https://example.com/a"
        );
        let blink = cell_dump(&replayed, 18, history).style;
        assert!(blink.blink);
        assert_eq!(
            blink.bg_color,
            StyleColor::Rgb(RgbColor { r: 1, g: 2, b: 3 })
        );
        assert_eq!(replayed.kitty_keyboard_flags().unwrap().bits(), 1);
        assert_eq!(key_probe(&replayed), key_probe(reference.term()));

        // The scroll region and the tab stops behave the same after the replay.
        let probe = b"\x1b[8;1Hbottom\nscrolled\x1b[10;1H\tT";
        replayed.vt_write(probe);
        reference.feed(probe);
        assert_equivalent(&replayed, reference.term());

        // modifyOtherKeys on its own (Kitty flags take precedence when both are set).
        let mut other_keys = TerminalState::new(3, 20, 4);
        let mut other_reference = Reference::new(3, 20, 4);
        other_keys.feed(b"\x1b[>4;2m");
        other_reference.feed(b"\x1b[>4;2m");
        let other_replayed = restored(&other_keys);
        assert_eq!(
            key_probe(&other_replayed),
            key_probe(other_reference.term())
        );
        assert_ne!(key_probe(&other_replayed), key_probe(&replay(3, 20, b"")));

        // Never the palette, default colours or the working directory.
        let snapshot = String::from_utf8_lossy(&state.snapshot()).into_owned();
        for osc in ["\x1b]4;", "\x1b]10;", "\x1b]11;", "\x1b]7;"] {
            assert!(!snapshot.contains(osc), "{osc:?} in {snapshot:?}");
        }
    }

    #[test]
    fn mode_2027_never_takes_effect_so_widths_stay_per_code_point() {
        let family = "👨\u{200d}👩\u{200d}👧";
        for prefix in ["\x1b[?2027h", "\x1b[?1;2027h"] {
            let mut state = TerminalState::new(3, 20, 4);
            state.feed(format!("{prefix}{family}|").as_bytes());
            let replayed = restored(&state);
            assert_eq!(
                replayed.cursor_x().unwrap(),
                7,
                "{prefix:?}: three wide code points and the bar"
            );
            assert!(!replayed.mode(Mode::GRAPHEME_CLUSTER).unwrap());
            assert!(!String::from_utf8_lossy(&state.snapshot()).contains("2027"));
        }
        // A terminal that honoured the mode would make the family one 2-cell cluster.
        let honoured = replay(3, 20, format!("\x1b[?2027h{family}|").as_bytes());
        assert_eq!(honoured.cursor_x().unwrap(), 3);
    }

    #[test]
    fn cursor_shape_survives_snapshot_and_replay() {
        for (sequence, shape, blinking) in [
            ("\x1b[6 q", "Bar", false),
            ("\x1b[5 q", "Bar", true),
            ("\x1b[4 q", "Underline", false),
            ("\x1b[3 q", "Underline", true),
            ("\x1b[2 q", "Block", false),
        ] {
            let mut state = TerminalState::new(3, 20, 4);
            let mut reference = Reference::new(3, 20, 4);
            let bytes = format!("abc{sequence}");
            state.feed(bytes.as_bytes());
            reference.feed(bytes.as_bytes());
            let replayed = restored(&state);
            assert_equivalent(&replayed, reference.term());
            let dump = state_dump(&replayed);
            assert_eq!(
                (dump.cursor_shape.as_str(), dump.cursor_blinking),
                (shape, blinking),
                "{sequence:?}"
            );
        }
    }

    /// Checkpoints written by the pre-libghostty runtime (generated with the code at `32d8ede1`).
    /// normal: 5x24, history 16, title "legacy era", busy command 1, output_seq 293.
    /// alt: 4x20, history 8, output_seq 59, alternate screen active.
    const LEGACY_NORMAL_CHECKPOINT: &[u8] = b"\x00\x00\x00\xbb{\"v\":1,\"output_seq\":293,\"rows\":5,\"cols\":24,\"title\":\"legacy era\",\"command\":{\"integrated\":true,\"busy\":true,\"commandSeq\":1,\"finishedSeq\":0},\"alt\":false,\"normal_len\":0,\"answered_query_seq\":0}\x1bc\x1b[0m\x1b[0;31mline 0\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;32mline 1\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;33mline 2\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;34mline 3\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;35mline 4\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;36mline 5\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;37mline 6\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[0;90mline 7\x1b[0m\x1b[K\x0d\x0a\x1b[0m$ \x1b[0;1;4m\xe7\x9c\x9fe\xcc\x81\x1b[0m wrapped beyond the\x1b[0m width\x1b[K\x0d\x0a\x1b[0mprompt$ \x1b[K\x1b[?25h\x1b[5;9H\x1b[m\x1b>\x1b[?1h\x1b[?2004h";
    const LEGACY_ALT_CHECKPOINT: &[u8] = b"\x00\x00\x00\xb2{\"v\":1,\"output_seq\":59,\"rows\":4,\"cols\":20,\"title\":\"\",\"command\":{\"integrated\":false,\"busy\":false,\"commandSeq\":0,\"finishedSeq\":0},\"alt\":true,\"normal_len\":86,\"answered_query_seq\":0}\x1bc\x1b[0mmain line\x1b[K\x0d\x0a\x1b[0msecond line\x1b[K\x0d\x0a\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[K\x1b[?25h\x1b[3;1H\x1b[m\x1b>\x1b[?1l\x1b[?2004l\x1bc\x1b[0mmain line\x1b[K\x0d\x0a\x1b[0msecond line\x1b[K\x0d\x0a\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[K\x1b[?25h\x1b[3;1H\x1b[m\x1b>\x1b[?1l\x1b[?2004l\x1b[?1049h\x1b[H\x1b[2J\x1b[0malt screen\x1b[K\x0d\x0a\x1b[0m  here\x1b[K\x0d\x0a\x1b[0m\x1b[K\x0d\x0a\x1b[0m\x1b[K\x1b[?25h\x1b[2;7H\x1b[m\x1b>\x1b[?1l\x1b[?2004l";

    #[test]
    fn sessiond_attach_snapshot_then_live_delta_is_contiguous() {
        let mut state = SessionState::new(3, 12, 4);
        state.feed(b"abc");
        let attached = state.attach("channel-1", "client-1", 1, None).unwrap();
        assert_eq!(attached.snapshot_seq, 3);
        assert!(attached.ansi_snapshot.is_some());
        assert!(attached.replay.is_empty());
        assert_eq!(attached.holder_epoch, 1);

        let pending = state.feed(b"de");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].channel_id, "channel-1");
        assert_eq!((pending[0].delta.from_seq, pending[0].delta.to_seq), (4, 5));
        state.delivery_result("channel-1", 5, true);
        assert!(state.pending_gaps().is_empty());
    }

    #[test]
    fn sessiond_attach_resume_starts_at_n_plus_one_or_falls_back_to_snapshot() {
        let mut state = SessionState::new(3, 12, 4);
        state.feed(b"abc");
        state.feed(b"de");
        let resumed = state.attach("channel-1", "client-1", 1, Some(3)).unwrap();
        assert_eq!(resumed.snapshot_seq, 3);
        assert_eq!(resumed.ansi_snapshot, None);
        assert_eq!(resumed.replay.len(), 1);
        assert_eq!(
            (resumed.replay[0].from_seq, resumed.replay[0].to_seq),
            (4, 5)
        );

        // seq 就是字节偏移：落在一条 delta 中间也能从那个字节起切片，不再退化成整屏 snapshot。
        let sliced = state.attach("channel-2", "client-1", 2, Some(4)).unwrap();
        assert_eq!(sliced.snapshot_seq, 4);
        assert_eq!(sliced.ansi_snapshot, None);
        assert_eq!(sliced.replay.len(), 1);
        assert_eq!(
            (
                sliced.replay[0].from_seq,
                sliced.replay[0].to_seq,
                sliced.replay[0].data.as_slice()
            ),
            (5, 5, &b"e"[..])
        );
        assert_eq!(
            sliced.holder_epoch, resumed.holder_epoch,
            "transport migration must not self-handoff"
        );

        // 超前于当前输出的 resume 无法回放：退回原子 snapshot。
        let fallback = state.attach("channel-3", "client-1", 3, Some(9)).unwrap();
        assert_eq!(fallback.snapshot_seq, 5);
        assert!(fallback.ansi_snapshot.is_some());
        assert!(fallback.replay.is_empty());
    }

    #[test]
    fn deltas_after_slices_inside_a_retained_delta_and_reads_the_ring_below_it() {
        let mut state = TerminalState::new(3, 12, 4);
        state.feed(b"abcdef");
        state.feed(b"ghi");
        let sliced = state.deltas_after(2).expect("偏移 2 之后仍在重发缓冲里");
        assert_eq!(sliced.len(), 2);
        assert_eq!(
            (
                sliced[0].from_seq,
                sliced[0].to_seq,
                sliced[0].data.as_slice()
            ),
            (3, 6, &b"cdef"[..])
        );
        assert_eq!(
            (
                sliced[1].from_seq,
                sliced[1].to_seq,
                sliced[1].data.as_slice()
            ),
            (7, 9, &b"ghi"[..])
        );
        assert_eq!(state.deltas_after(9), Some(Vec::new()));
        assert_eq!(state.deltas_after(10), None);

        // 重发缓冲之外、ring 之内：attach 经 ring 回调取整段。
        let mut session = SessionState::new(3, 12, 4);
        session.feed(b"abcdef");
        session.terminal.retransmit.clear();
        session.terminal.retransmit_bytes = 0;
        let mut asked = Vec::new();
        let outcome = session
            .attach_with_ring("channel-1", "client-1", 1, Some(2), &mut |from, to| {
                asked.push((from, to));
                Some(b"cdef".to_vec())
            })
            .unwrap();
        assert_eq!(asked, vec![(3, 6)]);
        assert_eq!(outcome.snapshot_seq, 2);
        assert_eq!(outcome.ansi_snapshot, None);
        assert_eq!(outcome.replay.len(), 1);
        assert_eq!(
            (
                outcome.replay[0].from_seq,
                outcome.replay[0].to_seq,
                outcome.replay[0].data.as_slice()
            ),
            (3, 6, &b"cdef"[..])
        );
        // ring 给的长度对不上就不冒充连续流。
        let short = session
            .attach_with_ring("channel-2", "client-1", 2, Some(2), &mut |_, _| {
                Some(b"cd".to_vec())
            })
            .unwrap();
        assert!(short.ansi_snapshot.is_some());
        assert!(short.replay.is_empty());
    }

    /// 把一条带 OSC 133 mark 的流在**每一个**字节位置切开：mark 内部任何位置都不许 checkpoint，
    /// 终止符之后才许。切在里面重放会把 `coflux=<secret>` 当文本打进屏幕与历史。
    #[test]
    fn checkpoint_eligibility_is_false_inside_an_osc_133_mark_and_true_after_its_terminator() {
        for terminator in [&b"\x07"[..], &b"\x1b\\"[..]] {
            let mut stream = b"prompt$ \x1b]133;A;coflux=deadbeef".to_vec();
            stream.extend_from_slice(terminator);
            stream.extend_from_slice(b"ls\r\n");
            let osc_start = stream.iter().position(|byte| *byte == 0x1b).unwrap();
            let osc_end = osc_start + b"\x1b]133;A;coflux=deadbeef".len() + terminator.len();
            for cut in 0..=stream.len() {
                let mut scanner = OutputScanner::default();
                for byte in &stream[..cut] {
                    scanner.feed(*byte);
                }
                let inside = cut > osc_start && cut < osc_end;
                assert_eq!(
                    scanner.between_sequences(),
                    !inside,
                    "cut={cut} terminator={terminator:?}：OSC 内部（{osc_start}<cut<{osc_end}）不许切，其余位置都许"
                );
            }
            // TerminalState 暴露的谓词与 scanner 一致：整条喂完就是安全点。
            let mut state = TerminalState::new(4, 40, 8).with_mark_secret("deadbeef".into());
            state.feed(&stream[..osc_end - 1]);
            assert!(!state.checkpoint_eligible());
            state.feed(&stream[osc_end - 1..]);
            assert!(state.checkpoint_eligible());
        }
    }

    #[test]
    fn checkpoint_eligibility_covers_csi_dcs_apc_and_utf8_continuations() {
        let cases: &[&[u8]] = &[
            b"\x1b[?1049h",
            b"\x1b[38;2;1;2;3m",
            b"\x1bPq#0;2;0;0;0#0~~\x1b\\",
            b"\x1b_Gf=100;\x1b\\",
            b"\x1b^pm\x1b\\",
            b"\x1bXsos\x1b\\",
            "真".as_bytes(),
            "\u{301}".as_bytes(),
        ];
        for sequence in cases {
            let mut scanner = OutputScanner::default();
            for (index, byte) in sequence.iter().enumerate() {
                scanner.feed(*byte);
                let last = index + 1 == sequence.len();
                assert_eq!(
                    scanner.between_sequences(),
                    last,
                    "{sequence:?} 第 {index} 字节之后：只有整条结束才是安全点"
                );
            }
        }
    }

    #[test]
    fn checkpoint_round_trips_screen_title_command_state_and_sequence() {
        let bytes = concat!(
            "plain\r\n",
            "\x1b]0;my title\x07",
            "\x1b]133;A;coflux=s3cret\x07$ ",
            "\x1b[38;2;12;34;56m真e\u{301}\x1b[48;5;201m彩色\x1b[0m\r\n",
            "third line\x1b[3DXYZ",
            "\x1b[?2004h\x1b[?1h\x1b[?25l"
        )
        .as_bytes();
        let mut state = TerminalState::new(5, 24, 16).with_mark_secret("s3cret".into());
        let mut reference = Reference::new(5, 24, 16);
        state.feed(bytes);
        reference.feed(bytes);
        assert!(state.checkpoint_eligible());
        let checkpoint = state.checkpoint(usize::MAX).unwrap();
        assert_eq!(checkpoint.output_seq, bytes.len() as u64);
        assert!(checkpoint.normal_before_alt.is_none());
        let encoded = checkpoint.encode();
        assert_eq!(encoded.len(), checkpoint.encoded_len());
        let decoded = Checkpoint::decode(&encoded).unwrap();
        assert_eq!(decoded, checkpoint);

        let mut restored_state = TerminalState::restore(&decoded, 16, "s3cret".into());
        assert_equivalent(&restored(&restored_state), reference.term());
        assert_eq!(restored_state.title(), "my title");
        assert_eq!(restored_state.command_state(), state.command_state());
        assert_eq!(restored_state.output_seq(), state.output_seq());
        assert!(restored_state.take_command_change().is_none());
        // 之后的字节在两边产生相同的屏幕与相同的序号。
        let tail = b"\r\nafter restore\x1b]133;C;coflux=s3cret\x07";
        let left = state.feed(tail).unwrap();
        let right = restored_state.feed(tail).unwrap();
        reference.feed(tail);
        assert_eq!((left.from_seq, left.to_seq), (right.from_seq, right.to_seq));
        assert_equivalent(&restored(&restored_state), reference.term());
        assert_equivalent(&restored(&state), reference.term());
        assert!(restored_state.command_state().busy);

        // A checkpoint taken in alt carries the primary snapshot in normal_before_alt and restores
        // both screens from its snapshot alone.
        let mut alt = TerminalState::new(4, 12, 8);
        let mut alt_reference = Reference::new(4, 12, 8);
        let alt_bytes = b"main line\r\n\x1b[?1049h\x1b[Halt!";
        alt.feed(alt_bytes);
        alt_reference.feed(alt_bytes);
        let alt_checkpoint = alt.checkpoint(usize::MAX).unwrap();
        let normal = alt_checkpoint
            .normal_before_alt
            .clone()
            .expect("alt checkpoints carry the primary");
        assert!(normal.starts_with(b"\x1bc"));
        assert!(alt_checkpoint.snapshot.starts_with(&normal));
        assert!(String::from_utf8_lossy(&normal).contains("main line"));
        assert!(!String::from_utf8_lossy(&normal).contains("1049"));
        let mut alt_restored = TerminalState::restore(
            &Checkpoint::decode(&alt_checkpoint.encode()).unwrap(),
            8,
            String::new(),
        );
        assert_eq!(
            restored(&alt_restored).active_screen().unwrap(),
            Screen::Alternate
        );
        assert_equivalent(&restored(&alt_restored), alt_reference.term());
        alt.feed(b"\x1b[?1049l");
        alt_restored.feed(b"\x1b[?1049l");
        alt_reference.feed(b"\x1b[?1049l");
        assert_equivalent(&restored(&alt_restored), alt_reference.term());
        assert_equivalent(&restored(&alt), alt_reference.term());
        assert!(plain_text(&restored(&alt_restored)).contains("main line"));

        // A checkpoint too big for its budget drops the oldest logical lines first, and is None
        // only when the screen alone does not fit.
        let mut long = TerminalState::new(3, 20, 64);
        for index in 0..40 {
            long.feed(format!("history line {index:02}\r\n").as_bytes());
        }
        let full = long.checkpoint(usize::MAX).unwrap();
        let smaller = long.checkpoint(full.encoded_len() - 1).unwrap();
        assert!(smaller.encoded_len() < full.encoded_len());
        let kept = plain_text(&replay(3, 20, &smaller.snapshot));
        assert!(kept.contains("history line 39") && !kept.contains("history line 00"));
        assert!(long.checkpoint(16).is_none());

        // 不认识的格式版本退化为 None，调用方只回放 ring。
        assert!(Checkpoint::decode(b"\x00\x00\x00\x02{}").is_none());
        let tampered = encoded.clone();
        let header_len = u32::from_be_bytes(tampered[..4].try_into().unwrap()) as usize;
        let header =
            String::from_utf8_lossy(&tampered[4..4 + header_len]).replace("\"v\":1", "\"v\":99");
        let mut future = (header.len() as u32).to_be_bytes().to_vec();
        future.extend_from_slice(header.as_bytes());
        future.extend_from_slice(&tampered[4 + header_len..]);
        assert!(Checkpoint::decode(&future).is_none());
    }

    #[test]
    fn a_checkpoint_written_by_the_previous_runtime_restores() {
        let checkpoint =
            Checkpoint::decode(LEGACY_NORMAL_CHECKPOINT).expect("the legacy blob decodes");
        assert_eq!(
            (
                checkpoint.rows,
                checkpoint.cols,
                checkpoint.output_seq,
                checkpoint.title.as_str()
            ),
            (5, 24, 293, "legacy era")
        );
        let mut normal = TerminalState::restore(&checkpoint, 16, "s3cret".into());
        assert!(normal.command_state().busy);
        assert_eq!(normal.output_seq(), 293);
        let text = plain_text(&restored(&normal));
        for expected in [
            "line 2",
            "line 7",
            "真e\u{301}",
            "wrapped beyond the width",
            "prompt$",
        ] {
            assert!(
                text.contains(expected),
                "{expected:?} missing from {text:?}"
            );
        }
        normal.feed(b"\x1b]133;D;0;coflux=s3cret\x07");
        assert_eq!(normal.command_state().exit_code, Some(0));
        // What this runtime writes still decodes with the unchanged decoder.
        let written = normal.checkpoint(usize::MAX).unwrap();
        assert_eq!(Checkpoint::decode(&written.encode()), Some(written));

        let alt = Checkpoint::decode(LEGACY_ALT_CHECKPOINT).expect("the legacy alt blob decodes");
        assert!(alt.normal_before_alt.is_some());
        let mut alt_state = TerminalState::restore(&alt, 8, String::new());
        let replayed = restored(&alt_state);
        assert_eq!(replayed.active_screen().unwrap(), Screen::Alternate);
        let alt_text = plain_text(&replayed);
        assert!(
            alt_text.contains("alt screen") && alt_text.contains("here"),
            "{alt_text:?}"
        );
        alt_state.feed(b"\x1b[?1049l");
        let primary = plain_text(&restored(&alt_state));
        assert!(
            primary.contains("main line") && primary.contains("second line"),
            "{primary:?}"
        );
        assert!(!primary.contains("alt screen"));
    }

    #[test]
    fn sessiond_holder_migration_keeps_epoch_and_rejects_old_transport() {
        let mut state = SessionState::new(3, 12, 4);
        let first = state.attach("direct-1", "client-a", 1, None).unwrap();
        let migrated = state.attach("relay-2", "client-a", 2, None).unwrap();
        assert_eq!(migrated.holder_epoch, first.holder_epoch);
        assert!(
            migrated.detached.is_none(),
            "same logical client must not detach itself"
        );
        assert_eq!(
            state
                .admit_input(
                    "direct-1",
                    "request-old",
                    first.holder_epoch,
                    1,
                    b"old".to_vec()
                )
                .unwrap_err()
                .code,
            "stale_transport"
        );
        assert_eq!(
            state.attach("stale", "client-a", 1, None).unwrap_err().code,
            "stale_transport"
        );
    }

    #[test]
    fn sessiond_holder_takeover_increments_epoch_and_detaches_previous_channel() {
        let mut state = SessionState::new(3, 12, 4);
        let first = state.attach("channel-a", "client-a", 1, None).unwrap();
        let second = state.attach("channel-b", "client-b", 1, None).unwrap();
        assert_eq!(second.holder_epoch, first.holder_epoch + 1);
        let detached = second.detached.unwrap();
        assert_eq!(detached.channel_id, "channel-a");
        assert_eq!(detached.holder_epoch, first.holder_epoch);
        assert_eq!(
            state
                .admit_input(
                    "channel-a",
                    "request-no",
                    first.holder_epoch,
                    1,
                    b"no".to_vec()
                )
                .unwrap_err()
                .code,
            "stale_holder"
        );
    }

    #[test]
    fn sessiond_holder_takeover_does_not_replay_or_discard_already_reserved_input() {
        let mut state = SessionState::new(3, 12, 4);
        let first = state.attach("channel-a", "client-a", 1, None).unwrap();
        assert!(matches!(
            state
                .admit_input(
                    "channel-a",
                    "request-a-1",
                    first.holder_epoch,
                    1,
                    b"accepted-before-takeover".to_vec(),
                )
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));

        let second = state.attach("channel-b", "client-b", 1, None).unwrap();
        assert!(matches!(
            state
                .admit_input(
                    "channel-b",
                    "request-b-1",
                    second.holder_epoch,
                    1,
                    b"new-holder".to_vec(),
                )
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));

        let old_completion = state.complete_input("client-a", 1).unwrap();
        assert_eq!(old_completion.channel_id, "channel-a");
        let new_completion = state.complete_input("client-b", 1).unwrap();
        assert_eq!(new_completion.channel_id, "channel-b");
        assert_eq!(new_completion.applied_through_seq, 1);
        assert_eq!(
            state
                .admit_input(
                    "channel-b",
                    "request-b-1-retry",
                    second.holder_epoch,
                    1,
                    b"new-holder".to_vec(),
                )
                .unwrap(),
            InputAdmission::Duplicate {
                applied_through_seq: 1
            }
        );
    }

    #[test]
    fn sessiond_holder_rejects_stale_generation_after_another_client_takes_over() {
        let mut state = SessionState::new(3, 12, 4);
        state.attach("channel-a-3", "client-a", 3, None).unwrap();
        state.attach("channel-b-1", "client-b", 1, None).unwrap();

        assert_eq!(
            state
                .attach("channel-a-2", "client-a", 2, None)
                .unwrap_err()
                .code,
            "stale_transport"
        );
        assert_eq!(
            state
                .attach("channel-a-other", "client-a", 3, None)
                .unwrap_err()
                .code,
            "generation_collision"
        );
        assert_eq!(
            state
                .attach("channel-a-3", "client-a", 4, None)
                .unwrap_err()
                .code,
            "generation_collision"
        );

        let current = state.attach("channel-a-4", "client-a", 4, None).unwrap();
        assert_eq!(current.holder_epoch, 3);
    }

    #[test]
    fn sessiond_logical_identity_limit_keeps_transport_input_and_resize_admission_consistent() {
        let mut state = SessionState::new(3, 12, 4);
        for index in 0..LOGICAL_CLIENT_LIMIT {
            let channel_id = format!("channel-{index}");
            let client_instance_id = format!("client-{index}");
            let attached = state
                .attach(&channel_id, &client_instance_id, 1, None)
                .unwrap();
            assert_eq!(
                state
                    .admit_input(
                        &channel_id,
                        &format!("request-{index}"),
                        attached.holder_epoch,
                        1,
                        vec![index as u8],
                    )
                    .unwrap(),
                InputAdmission::Enqueue {
                    client_instance_id: client_instance_id.clone()
                }
            );
            state.complete_input(&client_instance_id, 1).unwrap();
            assert_eq!(
                state
                    .resize_decision(&channel_id, attached.holder_epoch, 1, 24, 80)
                    .unwrap(),
                SequencedDecision::Apply
            );
            state
                .commit_resize(&channel_id, attached.holder_epoch, 1, 24, 80)
                .unwrap();
        }

        assert_eq!(state.transport_bindings.len(), LOGICAL_CLIENT_LIMIT);
        assert_eq!(state.input_cursors.len(), LOGICAL_CLIENT_LIMIT);
        assert_eq!(state.resize_cursors.len(), LOGICAL_CLIENT_LIMIT);
        assert!(state
            .input_cursors
            .keys()
            .all(|identity| state.transport_bindings.contains_key(identity)));
        assert!(state
            .resize_cursors
            .keys()
            .all(|identity| state.transport_bindings.contains_key(identity)));

        let rejected = state
            .attach("channel-overflow", "client-overflow", 1, None)
            .unwrap_err();
        assert_eq!(rejected.code, "logical_client_limit");
        assert_eq!(state.transport_bindings.len(), LOGICAL_CLIENT_LIMIT);
        assert_eq!(state.input_cursors.len(), LOGICAL_CLIENT_LIMIT);
        assert_eq!(state.resize_cursors.len(), LOGICAL_CLIENT_LIMIT);

        let migrated = state
            .attach("channel-0-migrated", "client-0", 2, None)
            .unwrap();
        assert!(
            migrated.holder_epoch > 0,
            "已准入 identity 在满额后仍可迁移"
        );
        assert_eq!(state.transport_bindings.len(), LOGICAL_CLIENT_LIMIT);
    }

    #[test]
    fn sessiond_holder_input_and_resize_sequences_are_idempotent() {
        let mut state = SessionState::new(3, 12, 4);
        let attached = state.attach("channel-a", "client-a", 1, None).unwrap();
        let epoch = attached.holder_epoch;

        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 0);
        assert_eq!(
            state
                .admit_input("channel-a", "request-gap", epoch, 2, b"gap".to_vec())
                .unwrap_err()
                .code,
            "input_seq_gap"
        );
        assert_eq!(
            state
                .admit_input("channel-a", "request-1", epoch, 1, b"hello".to_vec())
                .unwrap(),
            InputAdmission::Enqueue {
                client_instance_id: "client-a".into()
            }
        );
        assert_eq!(
            state
                .admit_input("channel-a", "request-2", epoch, 2, b"next".to_vec())
                .unwrap(),
            InputAdmission::Enqueue {
                client_instance_id: "client-a".into()
            },
            "未 ACK 的连续 input 仍可依次 reservation"
        );
        assert_eq!(
            state
                .admit_input("channel-a", "request-1-retry", epoch, 1, b"hello".to_vec())
                .unwrap(),
            InputAdmission::Pending,
            "写完成前同 seq 重投不能重复入队或提前 ACK"
        );
        assert_eq!(
            state
                .admit_input(
                    "channel-a",
                    "request-collision",
                    epoch,
                    1,
                    b"changed".to_vec()
                )
                .unwrap_err()
                .code,
            "input_seq_collision"
        );
        assert_eq!(
            state
                .admit_input("channel-a", "request-gap-2", epoch, 4, b"gap".to_vec())
                .unwrap_err()
                .code,
            "input_seq_gap"
        );

        // 同 logical client transport 迁移后会重投所有未确认输入；pending reservation 必须
        // 刷新 ACK channel，而不能写完后永久回给已失效的旧 transport。
        let migrated = state.attach("channel-b", "client-a", 2, None).unwrap();
        assert_eq!(migrated.holder_epoch, epoch);
        assert_eq!(
            state
                .admit_input("channel-b", "request-1-relay", epoch, 1, b"hello".to_vec())
                .unwrap(),
            InputAdmission::Pending
        );
        assert_eq!(
            state
                .admit_input("channel-b", "request-2-relay", epoch, 2, b"next".to_vec())
                .unwrap(),
            InputAdmission::Pending
        );
        let first = state.complete_input("client-a", 1).unwrap();
        assert_eq!(
            first,
            InputCompletion {
                channel_id: "channel-b".into(),
                applied_through_seq: 1
            }
        );
        let second = state.complete_input("client-a", 2).unwrap();
        assert_eq!(
            second,
            InputCompletion {
                channel_id: "channel-b".into(),
                applied_through_seq: 2
            }
        );
        assert_eq!(state.input_applied_through("channel-b", epoch).unwrap(), 2);
        assert_eq!(
            state
                .admit_input(
                    "channel-b",
                    "request-old",
                    epoch,
                    1,
                    b"changed stale payload".to_vec()
                )
                .unwrap(),
            InputAdmission::Duplicate {
                applied_through_seq: 2
            }
        );
        assert_eq!(
            state
                .admit_input(
                    "channel-b",
                    "request-last-collision",
                    epoch,
                    2,
                    b"changed".to_vec()
                )
                .unwrap_err()
                .code,
            "input_seq_collision"
        );

        assert_eq!(
            state
                .resize_decision("channel-b", epoch, 1, 40, 120)
                .unwrap(),
            SequencedDecision::Apply
        );
        state.commit_resize("channel-b", epoch, 1, 40, 120).unwrap();
        assert_eq!(
            state
                .resize_decision("channel-b", epoch, 1, 40, 120)
                .unwrap(),
            SequencedDecision::Duplicate
        );
        assert_eq!(
            state
                .resize_decision("channel-b", epoch, 1, 41, 120)
                .unwrap_err()
                .code,
            "resize_seq_collision"
        );
        assert_eq!(
            state
                .resize_decision("channel-b", epoch, 3, 50, 140)
                .unwrap(),
            SequencedDecision::Apply
        );
    }

    #[test]
    fn sessiond_backpressure_delivery_gap_does_not_stop_terminal_state() {
        let mut state = SessionState::new(4, 24, 8);
        let attached = state.attach("channel-a", "client-a", 1, None).unwrap();
        assert_eq!(attached.snapshot_seq, 0);

        let pending = state.feed(b"agent is working");
        assert_eq!(pending.len(), 1);
        state.delivery_result("channel-a", pending[0].delta.to_seq, false);
        let gaps = state.pending_gaps();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].expected_seq, 1);

        let marker = b"\r\nCOMPLETED";
        assert!(
            state.feed(marker).is_empty(),
            "gapped subscriber must not receive later out-of-order deltas"
        );
        assert_eq!(
            state.output_seq(),
            b"agent is working".len() as u64 + marker.len() as u64
        );

        let replayed = replay(4, 24, &state.snapshot());
        assert!(plain_text(&replayed).contains("COMPLETED"));
    }

    #[test]
    fn sessiond_backpressure_worker_reconnect_keeps_holder_and_migrates_transport() {
        let mut state = SessionState::new(3, 16, 4);
        let first = state.attach("direct-1", "client-a", 1, None).unwrap();
        state.clear_subscribers();
        assert!(state.subscriber_channels().is_empty());

        let migrated = state.attach("relay-2", "client-a", 2, None).unwrap();
        assert_eq!(migrated.holder_epoch, first.holder_epoch);
        assert!(migrated.detached.is_none());
        assert_eq!(
            state
                .admit_input(
                    "direct-1",
                    "request-stale",
                    first.holder_epoch,
                    1,
                    b"stale".to_vec()
                )
                .unwrap_err()
                .code,
            "stale_transport"
        );

        let pending = state.feed(b"online again");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].channel_id, "relay-2");
    }

    #[test]
    fn sessiond_backpressure_failed_attach_delivery_waits_for_retry() {
        let mut state = SessionState::new(3, 16, 4);
        let first = state.attach("channel-a", "client-a", 1, None).unwrap();
        state.remove_subscriber("channel-a");
        assert!(state.feed(b"not streamed").is_empty());

        let retried = state.attach("channel-a", "client-a", 1, None).unwrap();
        assert_eq!(retried.holder_epoch, first.holder_epoch);
        assert!(retried.ansi_snapshot.is_some());
        let pending = state.feed(b"streamed");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].channel_id, "channel-a");
    }

    /// 旧 ptyd 没有 `cursors`：重建出的 authority 拿不到"什么真正写进了 PTY"的记录。回来的 client 从它
    /// 上次的 seq 继续（比如 5）必须被接纳，而不是判 `input_seq_gap`——那会把一个能力缺失变成死 ack。
    #[test]
    fn cursorless_rebuild_accepts_a_returning_client_at_its_own_sequence_and_ptyd_rejections_are_not_fatal(
    ) {
        let mut state = SessionState::restore(TerminalState::new(3, 12, 4));
        state.set_cursorless_rebuild();
        let epoch = state
            .attach("channel-a", "client-a", 2, None)
            .unwrap()
            .holder_epoch;
        // 上一个 supervisor 已经 ack 过 1..4，client 继续投 5。
        let admitted = state
            .admit_input("channel-a", "request-5", epoch, 5, b"five".to_vec())
            .expect("拿不到游标时以 client 自报的 seq 为起点");
        assert_eq!(
            admitted,
            InputAdmission::Enqueue {
                client_instance_id: "client-a".into()
            }
        );
        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 4);
        // 起点一旦确立，之后照常连续：6 可以，8 是 gap。
        state.complete_input("client-a", 5).unwrap();
        assert!(matches!(
            state
                .admit_input("channel-a", "request-6", epoch, 6, b"six".to_vec())
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));
        assert_eq!(
            state
                .admit_input("channel-a", "request-8", epoch, 8, b"eight".to_vec())
                .unwrap_err()
                .code,
            "input_seq_gap"
        );
        // ptyd 按它的游标拒绝了 6：弹掉 reservation、把目标交回，session 没有封死，7 之后照常。
        let target = state.reject_pending_input("client-a", 6).unwrap();
        assert_eq!(
            (target.channel_id.as_str(), target.request_id.as_str()),
            ("channel-a", "request-6")
        );
        assert!(matches!(
            state
                .admit_input("channel-a", "request-6-again", epoch, 6, b"six".to_vec())
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));
        assert!(
            state.reject_pending_input("client-a", 9).is_err(),
            "只能弹队首那一条"
        );

        // 有游标的正常重建不受影响：跳号仍是 gap。
        let mut strict = SessionState::restore(TerminalState::new(3, 12, 4));
        strict.restore_input_cursor("client-a", 4, b"four".to_vec());
        let epoch = strict
            .attach("channel-a", "client-a", 2, None)
            .unwrap()
            .holder_epoch;
        assert!(matches!(
            strict
                .admit_input("channel-a", "r", epoch, 5, b"five".to_vec())
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));
        let mut fresh = SessionState::restore(TerminalState::new(3, 12, 4));
        let epoch = fresh
            .attach("channel-a", "client-a", 2, None)
            .unwrap()
            .holder_epoch;
        assert_eq!(
            fresh
                .admit_input("channel-a", "r", epoch, 5, b"five".to_vec())
                .unwrap_err()
                .code,
            "input_seq_gap"
        );
    }

    /// Stream offsets (0-based) of the bytes the scanner reports as completing a DA1 query, with
    /// the stream fed one byte at a time across `chunks`.
    fn scanner_da1_positions(chunks: &[&[u8]]) -> Vec<usize> {
        let mut scanner = OutputScanner::default();
        let mut positions = Vec::new();
        let mut offset = 0;
        for chunk in chunks {
            for byte in *chunk {
                if scanner.feed(*byte) == Some(ScanEvent::Da1Query) {
                    positions.push(offset);
                }
                offset += 1;
            }
        }
        positions
    }

    /// DA1 queries as xterm.js (and the pre-libghostty runtime) recognise them: no intermediate
    /// and no private marker, final `c`, every parameter zero. A query sessiond answers must be
    /// one a client would have answered, so these are xterm.js's semantics, not libghostty's.
    const DA1_CASES: &[(&[u8], usize)] = &[
        (b"\x1b[c", 1),
        (b"\x1b[0c", 1),
        (b"\x1b[0;0c", 1),
        (b"\x1b[c\x1b[0c", 2),
        (b"\x1b[?1;2c", 0),
        (b"\x1b[>c", 0),
        (b"\x1b[>0c", 0),
        (b"\x1b[=c", 0),
        (b"\x1b[1c", 0),
        (b"\x1b[5c", 0),
        (b"\x1b[ c", 0),
        (b"\x1bc", 0),
        (b"\x1b]0;[c\x07", 0),
        (b"\x1bP[c\x1b\\", 0),
        (b"\x1b[;c", 1),
        (b"\x1b[00c", 1),
        (b"\x1b[0:0c", 1),
        (b"\x1b[0:1c", 0),
        (b"\x1b[10c", 0),
        (b"\x1b[0\x18c", 0),
        (b"\x1b[0\x07c", 1),
        (b"\x1b[0;?c", 0),
        (b"\x1b[ 0c", 0),
    ];

    #[test]
    fn output_scanner_recognises_completed_da1_queries_only() {
        for &(input, expected) in DA1_CASES {
            assert_eq!(
                scanner_da1_positions(&[input]).len(),
                expected,
                "DA1 completions for {input:?}"
            );
        }
        // The completion is reported at the final `c`, not earlier.
        assert_eq!(scanner_da1_positions(&[b"\x1b[c"]), vec![2]);
        assert_eq!(scanner_da1_positions(&[b"\x1b[c\x1b[0c"]), vec![2, 6]);
        // Split across chunk boundaries the state carries over.
        assert_eq!(scanner_da1_positions(&[b"\x1b[", b"c"]), vec![2]);
        assert_eq!(scanner_da1_positions(&[b"\x1b", b"[0", b"c"]), vec![3]);
        // Recognising DA1 does not change the sequence-boundary answer.
        let mut scanner = OutputScanner::default();
        for byte in b"\x1b[?1049h\x1b[" {
            scanner.feed(*byte);
        }
        assert_eq!(scanner.feed(b'c'), Some(ScanEvent::Da1Query));
        assert!(scanner.between_sequences());
        assert_eq!(
            scanner.feed(b'x'),
            None,
            "the event describes its own byte only"
        );
    }

    #[test]
    fn output_scanner_da1_survives_every_chunk_split() {
        for &(input, expected) in DA1_CASES {
            for cut in 0..=input.len() {
                assert_eq!(
                    scanner_da1_positions(&[&input[..cut], &input[cut..]]).len(),
                    expected,
                    "{input:?} split at {cut}"
                );
            }
            let bytes: Vec<&[u8]> = input.chunks(1).collect();
            assert_eq!(
                scanner_da1_positions(&bytes).len(),
                expected,
                "{input:?} byte by byte"
            );
        }
        let stream: Vec<u8> = DA1_CASES
            .iter()
            .flat_map(|(input, _)| input.iter().copied())
            .collect();
        let total: usize = DA1_CASES.iter().map(|(_, expected)| expected).sum();
        let whole = scanner_da1_positions(&[&stream]);
        assert_eq!(whole.len(), total);
        for cut in 0..=stream.len() {
            assert_eq!(
                scanner_da1_positions(&[&stream[..cut], &stream[cut..]]),
                whole,
                "cut {cut}"
            );
        }
    }

    #[test]
    fn output_scanner_reports_every_decset_of_mode_2027() {
        let positions = |input: &[u8]| -> Vec<usize> {
            let mut scanner = OutputScanner::default();
            input
                .iter()
                .enumerate()
                .filter(|(_, byte)| scanner.feed(**byte) == Some(ScanEvent::GraphemeClusterSet))
                .map(|(index, _)| index)
                .collect()
        };
        assert_eq!(positions(b"\x1b[?2027h"), vec![7]);
        assert_eq!(positions(b"a\x1b[?1;2027;25hb\x1b[?2027h"), vec![13, 22]);
        assert_eq!(
            positions(b"\x1b[?02027h"),
            vec![8],
            "the value, not the spelling"
        );
        for not_a_set in [
            &b"\x1b[?2027l"[..],
            b"\x1b[2027h",
            b"\x1b[?20270h",
            b"\x1b[?2026h",
            b"\x1b]0;?2027h\x07",
            b"\x1b[?2027\x18h",
        ] {
            assert!(positions(not_a_set).is_empty(), "{not_a_set:?}");
        }
    }

    #[test]
    fn terminal_feed_records_the_offset_of_every_da1_query() {
        let mut state = TerminalState::new(4, 12, 8);
        state.feed(b"x\x1b[cyyyy");
        assert_eq!(state.take_da1_queries(), vec![4]);
        assert!(state.take_da1_queries().is_empty(), "drained");

        state.feed(b"\x1b[c\x1b[0c");
        assert_eq!(state.take_da1_queries(), vec![11, 15]);

        // A query split across two feeds is recorded by the feed that completes it.
        state.feed(b"\x1b[");
        assert!(state.take_da1_queries().is_empty());
        state.feed(b"c");
        assert_eq!(state.take_da1_queries(), vec![18]);

        // The query is consumed by the terminal: the screen shows only the text around it.
        let mut plain = TerminalState::new(4, 12, 8);
        plain.feed(b"ab\x1b[cd");
        assert_eq!(plain_text(&restored(&plain)).trim_end(), "abd");

        // resize and restore replay canonical snapshots and record nothing.
        plain.feed(b"\x1b[c");
        assert_eq!(plain.take_da1_queries().len(), 1);
        plain.resize(5, 20);
        assert!(plain.take_da1_queries().is_empty());
        let mut restored_state =
            TerminalState::restore(&plain.checkpoint(usize::MAX).unwrap(), 8, String::new());
        assert!(restored_state.take_da1_queries().is_empty());
        plain.feed(b"\x1b[c");
        plain.feed(b"z");
        assert!(
            plain.take_da1_queries().is_empty(),
            "a later feed replaces an undrained record"
        );
    }

    #[test]
    fn libghostty_replies_never_reach_the_pty_and_images_are_not_stored() {
        // Queries libghostty would answer itself: DA2/DA3, DECRQM, DSR, XTVERSION, size reports,
        // colour scheme, OSC colour queries, ENQ.
        let queries =
            b"\x1b[>c\x1b[=c\x1b[?2004$p\x1b[5n\x1b[6n\x1b[>q\x1b[18t\x1b[?996n\x1b]11;?\x07\x05";
        let mut state = SessionState::new(3, 20, 4);
        state.feed(queries);
        assert!(
            state.take_query_replies().is_empty(),
            "sessiond answers DA1 only"
        );
        state.feed(b"\x1b[c");
        assert_eq!(state.take_query_replies(), vec![DA1_REPLY.to_vec()]);

        // A Kitty graphics transmission carrying data is dropped whole by the zero APC budget, so
        // no image is ever stored; a terminal with libghostty's default budget stores and places it.
        let image = format!(
            "\x1b_Ga=T,f=24,s=32,v=32,i=7;{}\x1b\\after",
            "A".repeat(4096)
        );
        let placements = |term: &Term| -> usize {
            let mut render = RenderState::new().unwrap();
            let snapshot = render.update(term).unwrap();
            let mut images = libghostty_vt::render::ImageIterator::new().unwrap();
            let mut iteration = images.update(&snapshot).unwrap();
            let mut count = 0;
            while iteration.next().is_some() {
                count += 1;
            }
            count
        };
        let mut budgeted: Term = Terminal::new(20, 3).unwrap();
        budgeted.set_apc_max_bytes(Some(0)).unwrap();
        budgeted.resize(20, 3, 8, 16).unwrap();
        budgeted.vt_write(image.as_bytes());
        let mut unbudgeted: Term = Terminal::new(20, 3).unwrap();
        unbudgeted.resize(20, 3, 8, 16).unwrap();
        unbudgeted.vt_write(image.as_bytes());
        assert_eq!(placements(&unbudgeted), 1, "the probe sees a stored image");
        assert_eq!(placements(&budgeted), 0);
        let mut reference = Reference::new(3, 20, 4);
        reference.feed(image.as_bytes());
        assert_eq!(placements(reference.term()), 0);
        assert!(plain_text(reference.term()).contains("after"));
    }

    #[test]
    fn session_answers_da1_when_no_holder_receives_the_raw_output() {
        let mut state = SessionState::new(3, 12, 4);
        let pending = state.feed(b"\x1b[c");
        assert!(pending.is_empty());
        assert_eq!(state.take_query_replies(), vec![b"\x1b[?1;2c".to_vec()]);
        assert!(state.take_query_replies().is_empty(), "drained");
        assert_eq!(
            state.answered_query_seq(),
            3,
            "the `c` is the chunk's last byte"
        );

        let mut two = SessionState::new(3, 12, 4);
        two.feed(b"\x1b[c\x1b[0c");
        assert_eq!(two.take_query_replies(), vec![b"\x1b[?1;2c".to_vec(); 2]);
        assert_eq!(two.answered_query_seq(), 7);

        let mut tail = SessionState::new(3, 12, 4);
        tail.feed(b"x\x1b[cyyyy");
        assert_eq!(tail.take_query_replies().len(), 1);
        assert_eq!(
            tail.answered_query_seq(),
            4,
            "marker at the `c`, not the chunk's to_seq (8)"
        );

        // A feed without a query replaces a reply buffer nobody took and leaves the marker alone.
        let mut stale = SessionState::new(3, 12, 4);
        stale.feed(b"\x1b[c");
        stale.feed(b"hello");
        assert!(stale.take_query_replies().is_empty());
        assert_eq!(stale.answered_query_seq(), 3);
    }

    #[test]
    fn session_leaves_da1_to_a_human_holder_that_receives_the_raw_output() {
        let mut state = SessionState::new(3, 12, 4);
        state.attach("channel-1", "client-1", 1, None).unwrap();
        let pending = state.feed(b"\x1b[c");
        assert_eq!(pending.len(), 1);
        assert!(state.take_query_replies().is_empty(), "xterm.js answers it");
        assert_eq!(state.answered_query_seq(), 0);

        // A gapped holder does not receive the bytes, so sessiond answers.
        let mut gapped = SessionState::new(3, 12, 4);
        gapped.attach("channel-1", "client-1", 1, None).unwrap();
        let pending = gapped.feed(b"a");
        gapped.delivery_result("channel-1", pending[0].delta.to_seq, false);
        assert!(gapped.feed(b"\x1b[c").is_empty());
        assert_eq!(gapped.take_query_replies().len(), 1);
        assert_eq!(gapped.answered_query_seq(), 4);

        // An agent holder stays subscribed but never answers.
        let mut agent = SessionState::new(3, 12, 4);
        agent
            .attach(
                "__coflux-agent-client-1-g1",
                "__coflux-agent-client-1",
                1,
                None,
            )
            .unwrap();
        let pending = agent.feed(b"\x1b[c");
        assert_eq!(
            pending.len(),
            1,
            "the agent channel still receives the delta"
        );
        assert_eq!(agent.take_query_replies().len(), 1);
        assert_eq!(agent.answered_query_seq(), 3);
    }

    #[test]
    fn resume_below_an_answered_query_falls_back_to_a_snapshot() {
        let mut state = SessionState::new(3, 12, 4);
        state.feed(b"a");
        state.feed(b"\x1b[c");
        assert_eq!(state.answered_query_seq(), 4);

        let below = state.attach("channel-1", "client-1", 1, Some(1)).unwrap();
        assert!(below.ansi_snapshot.is_some());
        assert!(below.replay.is_empty());
        assert_eq!(below.snapshot_seq, 4);

        // The client holds `ESC [` but not the `c`: replaying the `c` would complete the query.
        let inside = state.attach("channel-2", "client-1", 2, Some(3)).unwrap();
        assert!(inside.ansi_snapshot.is_some());
        assert!(inside.replay.is_empty());

        let after = state.attach("channel-3", "client-1", 3, Some(4)).unwrap();
        assert_eq!(after.ansi_snapshot, None);
        assert!(after.replay.is_empty());
        assert_eq!(after.snapshot_seq, 4);

        // The ring is not consulted either.
        let mut ringed = SessionState::new(3, 12, 4);
        ringed.feed(b"a");
        ringed.feed(b"\x1b[c");
        ringed.terminal.retransmit.clear();
        ringed.terminal.retransmit_bytes = 0;
        let mut asked = Vec::new();
        let outcome = ringed
            .attach_with_ring("channel-1", "client-1", 1, Some(1), &mut |from, to| {
                asked.push((from, to));
                Some(b"\x1b[c".to_vec())
            })
            .unwrap();
        assert!(asked.is_empty());
        assert!(outcome.ansi_snapshot.is_some());
        assert!(outcome.replay.is_empty());
    }

    #[test]
    fn answered_query_marker_survives_a_checkpoint_and_never_moves_down() {
        let mut state = SessionState::new(3, 12, 4);
        state.feed(b"\x1b[c");
        assert_eq!(state.answered_query_seq(), 3);
        state.raise_answered_query_seq(2);
        assert_eq!(state.answered_query_seq(), 3, "never lowered");

        let checkpoint = state.checkpoint(usize::MAX).unwrap();
        assert_eq!(checkpoint.answered_query_seq, 3);
        let encoded = checkpoint.encode();
        assert_eq!(encoded.len(), checkpoint.encoded_len());
        let decoded = Checkpoint::decode(&encoded).unwrap();
        assert_eq!(decoded, checkpoint);
        let restored = SessionState::restore(TerminalState::restore(&decoded, 4, String::new()));
        assert_eq!(restored.answered_query_seq(), 3);

        let mut carried = SessionState::new(3, 12, 4);
        carried.raise_answered_query_seq(restored.answered_query_seq());
        assert_eq!(carried.answered_query_seq(), 3);

        // A header written before the field existed still decodes, with marker 0.
        let header_len = u32::from_be_bytes(encoded[..4].try_into().unwrap()) as usize;
        let mut header: serde_json::Value =
            serde_json::from_slice(&encoded[4..4 + header_len]).unwrap();
        assert!(header
            .as_object_mut()
            .unwrap()
            .remove("answered_query_seq")
            .is_some());
        let header = serde_json::to_vec(&header).unwrap();
        let mut legacy = (header.len() as u32).to_be_bytes().to_vec();
        legacy.extend_from_slice(&header);
        legacy.extend_from_slice(&encoded[4 + header_len..]);
        let legacy = Checkpoint::decode(&legacy).expect("an older header must still decode");
        assert_eq!(legacy.answered_query_seq, 0);
        assert_eq!(legacy.output_seq, 3);
    }
}
