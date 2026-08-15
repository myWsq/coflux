//! sessiond 的纯状态核心：VT grid/history、规范化 ANSI snapshot、输出序号与 channel stream。
//!
//! 本模块不持有 PTY/网络对象，单测可以把生成的 ANSI snapshot 喂给第二个 `vt100::Parser`
//! 做状态等价验证。PTY 生命周期与 Device channel 路由留在 `sessions.rs`。

use std::collections::{HashMap, VecDeque};

use vt100::{Cell, Color, Screen};

const HISTORY_WRAP_FACTOR: usize = 4;
const RETRANSMIT_LIMIT: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AltEvent {
    Enter,
    Exit,
}

#[derive(Debug, Default)]
struct DecModeScanner {
    state: ScanState,
}

#[derive(Debug, Default)]
enum ScanState {
    #[default]
    Ground,
    Escape,
    Csi { private: bool, params: Vec<u16>, current: u16, has_digit: bool },
}

impl DecModeScanner {
    fn feed(&mut self, byte: u8) -> Option<AltEvent> {
        match &mut self.state {
            ScanState::Ground => {
                if byte == 0x1b {
                    self.state = ScanState::Escape;
                }
                None
            }
            ScanState::Escape => {
                self.state = if byte == b'[' {
                    ScanState::Csi { private: false, params: Vec::new(), current: 0, has_digit: false }
                } else if byte == 0x1b {
                    ScanState::Escape
                } else {
                    ScanState::Ground
                };
                None
            }
            ScanState::Csi { private, params, current, has_digit } => {
                match byte {
                    b'?' if params.is_empty() && !*has_digit => *private = true,
                    b'0'..=b'9' => {
                        *current = current.saturating_mul(10).saturating_add(u16::from(byte - b'0'));
                        *has_digit = true;
                    }
                    b';' => {
                        params.push(if *has_digit { *current } else { 0 });
                        *current = 0;
                        *has_digit = false;
                    }
                    0x40..=0x7e => {
                        if *has_digit || !params.is_empty() {
                            params.push(if *has_digit { *current } else { 0 });
                        }
                        let is_alt = *private && params.iter().any(|p| matches!(p, 47 | 1049));
                        let event = if is_alt && byte == b'h' {
                            Some(AltEvent::Enter)
                        } else if is_alt && byte == b'l' {
                            Some(AltEvent::Exit)
                        } else {
                            None
                        };
                        self.state = ScanState::Ground;
                        return event;
                    }
                    0x1b => self.state = ScanState::Escape,
                    _ => {}
                }
                None
            }
        }
    }
}

/// OSC 标题的长度钳制（plan 075）：标题是 PTY 内程序给的不可信输入，源头截断。
const MAX_TITLE_BYTES: usize = 256;

/// OSC 0/2 终端标题捕获（plan 075）。vt100 只在回调瞬间给出 bytes，这里暂存一拍，
/// `TerminalState::feed` 处理完后收割到自身字段——parser 在 resize 时会被整个重建
/// （规范 snapshot 重放不含 OSC），标题的存续必须独立于 parser 生命周期。
/// `Option` 区分「本轮没有标题事件」与「程序显式设空标题」。
#[derive(Default)]
struct TitleCapture {
    pending: Option<Vec<u8>>,
}

impl vt100::Callbacks for TitleCapture {
    fn set_window_title(&mut self, _: &mut Screen, title: &[u8]) {
        self.pending = Some(title.to_vec());
    }
}

/// 不可信标题的规范化：lossy 解码、剔除控制字符、按字符边界截到 MAX_TITLE_BYTES。
fn clamp_title(raw: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(raw).chars().filter(|c| !c.is_control()).collect();
    if text.len() <= MAX_TITLE_BYTES {
        return text;
    }
    let mut end = MAX_TITLE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub struct TerminalState {
    parser: vt100::Parser<TitleCapture>,
    /// PTY 内程序经 OSC 0/2 设置的终端标题；空 = 从未设置。跨 resize 存续。
    title: String,
    rows: u16,
    cols: u16,
    history_line_limit: usize,
    history_row_capacity: usize,
    output_seq: u64,
    retransmit: VecDeque<Delta>,
    retransmit_bytes: usize,
    mode_scanner: DecModeScanner,
    /// 进入 alt screen 前的完整主屏 snapshot；退出 alt 后由 vt100 内部主 grid 接回。
    normal_before_alt: Option<Vec<u8>>,
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16, history_line_limit: usize) -> Self {
        let history_row_capacity = history_line_limit.saturating_mul(HISTORY_WRAP_FACTOR);
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, history_row_capacity, TitleCapture::default()),
            title: String::new(),
            rows,
            cols,
            history_line_limit,
            history_row_capacity,
            output_seq: 0,
            retransmit: VecDeque::new(),
            retransmit_bytes: 0,
            mode_scanner: DecModeScanner::default(),
            normal_before_alt: None,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Option<Delta> {
        if bytes.is_empty() {
            return None;
        }

        // 只在 alt mode 边界拆 chunk；其余仍批量交给 vte，避免逐 byte clone/dispatch。
        let mut start = 0;
        for (index, byte) in bytes.iter().copied().enumerate() {
            let Some(event) = self.mode_scanner.feed(byte) else { continue };
            if start < index {
                self.parser.process(&bytes[start..index]);
            }
            let was_alt = self.parser.screen().alternate_screen();
            if event == AltEvent::Enter && !was_alt {
                self.normal_before_alt = Some(render_normal_snapshot(
                    self.parser.screen(),
                    self.history_line_limit,
                    self.history_row_capacity,
                ));
            }
            self.parser.process(&bytes[index..=index]);
            if event == AltEvent::Exit && was_alt && !self.parser.screen().alternate_screen() {
                self.normal_before_alt = None;
            }
            start = index + 1;
        }
        if start < bytes.len() {
            self.parser.process(&bytes[start..]);
        }
        if let Some(pending) = self.parser.callbacks_mut().pending.take() {
            self.title = clamp_title(&pending);
        }

        let from_seq = self.output_seq.saturating_add(1);
        self.output_seq = self.output_seq.saturating_add(bytes.len() as u64);
        let delta = Delta { from_seq, to_seq: self.output_seq, data: bytes.to_vec() };
        self.push_retransmit(delta.clone());
        Some(delta)
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

    pub fn snapshot(&self) -> Vec<u8> {
        if self.parser.screen().alternate_screen() {
            let mut snapshot = self.normal_before_alt.clone().unwrap_or_else(|| b"\x1bc".to_vec());
            snapshot.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
            render_active_grid(&mut snapshot, self.parser.screen(), &[]);
            snapshot
        } else {
            render_normal_snapshot(self.parser.screen(), self.history_line_limit, self.history_row_capacity)
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        if self.rows == rows && self.cols == cols {
            return;
        }
        // vt100::Grid::set_size 在列数变化时会直接清掉 wrap 标记并截/补每个 physical row，
        // 与浏览器 xterm 的 logical-line reflow 不一致；尤其 alt screen 激活时，隐藏 normal
        // screen 会停在旧布局，退出 alt 后丢行。先把规范 snapshot 当成逻辑行流，再在新尺寸的
        // parser 中重放，既保留 hard line 边界，也让 normal/history 与 xterm 按新列宽重排。
        let was_alt = self.parser.screen().alternate_screen();
        let normal = if was_alt {
            self.normal_before_alt.clone().unwrap_or_else(|| b"\x1bc".to_vec())
        } else {
            render_normal_snapshot(self.parser.screen(), self.history_line_limit, self.history_row_capacity)
        };
        let reflowed_normal = reflow_normal_snapshot(
            &normal,
            self.rows,
            self.cols,
            rows,
            cols,
            self.history_line_limit,
            self.history_row_capacity,
        );
        let snapshot = if was_alt {
            let mut snapshot = reflowed_normal.clone();
            snapshot.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
            render_active_grid(&mut snapshot, self.parser.screen(), &[]);
            snapshot
        } else {
            reflowed_normal.clone()
        };
        let mut parser = vt100::Parser::new_with_callbacks(rows, cols, self.history_row_capacity, TitleCapture::default());
        parser.process(&snapshot);
        self.parser = parser;
        self.normal_before_alt = was_alt.then_some(reflowed_normal);
        self.rows = rows;
        self.cols = cols;
    }

    pub fn output_seq(&self) -> u64 {
        self.output_seq
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn earliest_retransmit_seq(&self) -> u64 {
        self.retransmit.front().map(|delta| delta.from_seq).unwrap_or_else(|| self.output_seq.saturating_add(1))
    }

    /// `last_seq` 必须位于 whole-frame 边界；否则调用方应返回原子 snapshot。
    fn deltas_after(&self, last_seq: u64) -> Option<Vec<Delta>> {
        if last_seq == self.output_seq {
            return Some(Vec::new());
        }
        let expected = last_seq.checked_add(1)?;
        let start = self.retransmit.iter().position(|delta| delta.from_seq == expected)?;
        let mut next = expected;
        let mut output = Vec::new();
        for delta in self.retransmit.iter().skip(start) {
            if delta.from_seq != next {
                return None;
            }
            output.push(delta.clone());
            next = delta.to_seq.saturating_add(1);
        }
        (next == self.output_seq.saturating_add(1)).then_some(output)
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
    resize_cursors: HashMap<String, ResizeCursor>,
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
            resize_cursors: HashMap::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<PendingDelta> {
        let Some(delta) = self.terminal.feed(bytes) else { return Vec::new() };
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
            pending.push(PendingDelta { channel_id: channel_id.clone(), delta: delta.clone() });
        }
        pending
    }

    pub fn attach(
        &mut self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
        resume_from_seq: Option<u64>,
    ) -> Result<AttachOutcome, AttachError> {
        self.validate_attach(channel_id, client_instance_id, transport_generation)?;
        let mut detached = None;
        let epoch = match &self.holder {
            None => self.bump_holder_epoch(),
            Some(holder) if holder.client_instance_id == client_instance_id => {
                if transport_generation > holder.transport_generation && holder.channel_id != channel_id {
                    self.subscribers.remove(&holder.channel_id);
                }
                holder.epoch
            }
            Some(holder) => {
                detached = Some(DetachedTarget { channel_id: holder.channel_id.clone(), holder_epoch: holder.epoch });
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
            TransportBinding { generation: transport_generation, channel_id: channel_id.to_string() },
        );

        let (snapshot_seq, ansi_snapshot, replay) = match resume_from_seq.and_then(|seq| self.terminal.deltas_after(seq).map(|deltas| (seq, deltas))) {
            Some((seq, replay)) => (seq, None, replay),
            None => (self.terminal.output_seq(), Some(self.terminal.snapshot()), Vec::new()),
        };
        self.subscribers.insert(
            channel_id.to_string(),
            Subscriber { next_seq: snapshot_seq.saturating_add(1), gapped: false, gap_notified: false },
        );
        Ok(AttachOutcome { holder_epoch: epoch, snapshot_seq, ansi_snapshot, replay, detached })
    }

    pub fn validate_attach(
        &self,
        channel_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
    ) -> Result<(), AttachError> {
        if channel_id.is_empty() || client_instance_id.is_empty() || transport_generation == 0 {
            return Err(AttachError { code: "invalid_attach", message: "channel/client/generation 必须有效".into() });
        }
        if let Some(binding) = self.transport_bindings.get(client_instance_id) {
            if transport_generation < binding.generation {
                return Err(AttachError { code: "stale_transport", message: "transport generation 已过期".into() });
            }
            if transport_generation == binding.generation && binding.channel_id != channel_id {
                return Err(AttachError { code: "generation_collision", message: "同一 transport generation 不能绑定不同 channel".into() });
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
        let Some(subscriber) = self.subscribers.get_mut(channel_id) else { return };
        if sent && subscriber.next_seq <= to_seq {
            subscriber.next_seq = to_seq.saturating_add(1);
        } else if !sent {
            subscriber.gapped = true;
            subscriber.gap_notified = false;
        }
    }

    pub fn pending_gaps(&self) -> Vec<PendingGap> {
        let available_seq = self.terminal.earliest_retransmit_seq();
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
            return Err(ControlError { code: "no_holder", message: "session 当前没有 holder".into() });
        };
        if holder.epoch != holder_epoch {
            return Err(ControlError { code: "stale_holder", message: "holder epoch 已过期".into() });
        }
        if holder.channel_id != channel_id {
            return Err(ControlError { code: "stale_transport", message: "该 channel 已不是当前 transport".into() });
        }
        Ok(holder)
    }

    pub fn authorize_holder(&self, channel_id: &str, holder_epoch: u64) -> Result<(), ControlError> {
        self.current_holder(channel_id, holder_epoch).map(|_| ())
    }

    pub fn input_decision(
        &self,
        channel_id: &str,
        holder_epoch: u64,
        input_seq: u64,
        data: &[u8],
    ) -> Result<SequencedDecision, ControlError> {
        if input_seq == 0 {
            return Err(ControlError { code: "invalid_input_seq", message: "input sequence 必须从 1 开始".into() });
        }
        let holder = self.current_holder(channel_id, holder_epoch)?;
        match self.input_cursors.get(&holder.client_instance_id) {
            None if input_seq == 1 => Ok(SequencedDecision::Apply),
            None => Err(ControlError { code: "input_seq_gap", message: "input sequence 不连续，期望 1".into() }),
            Some(cursor) if cursor.seq.checked_add(1) == Some(input_seq) => Ok(SequencedDecision::Apply),
            Some(cursor) if input_seq == cursor.seq && cursor.data == data => Ok(SequencedDecision::Duplicate),
            Some(cursor) if input_seq == cursor.seq => {
                Err(ControlError { code: "input_seq_collision", message: "相同 input sequence 携带了不同 payload".into() })
            }
            Some(cursor) if input_seq < cursor.seq => Ok(SequencedDecision::Duplicate),
            Some(cursor) => Err(ControlError {
                code: "input_seq_gap",
                message: format!("input sequence 不连续，期望 {}", cursor.seq.saturating_add(1)),
            }),
        }
    }

    pub fn input_applied_through(&self, channel_id: &str, holder_epoch: u64) -> Result<u64, ControlError> {
        let holder = self.current_holder(channel_id, holder_epoch)?;
        Ok(self.input_cursors.get(&holder.client_instance_id).map_or(0, |cursor| cursor.seq))
    }

    pub fn commit_input(&mut self, channel_id: &str, holder_epoch: u64, input_seq: u64, data: Vec<u8>) -> Result<(), ControlError> {
        let client_instance_id = self.current_holder(channel_id, holder_epoch)?.client_instance_id.clone();
        let applied_through = self.input_cursors.get(&client_instance_id).map_or(0, |cursor| cursor.seq);
        let Some(expected) = applied_through.checked_add(1) else {
            return Err(ControlError { code: "input_seq_exhausted", message: "input sequence 已耗尽".into() });
        };
        if input_seq != expected {
            return Err(ControlError {
                code: "input_commit_out_of_order",
                message: format!("input commit 不连续，期望 {expected}"),
            });
        }
        self.input_cursors.insert(client_instance_id, InputCursor { seq: input_seq, data });
        Ok(())
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
            return Err(ControlError { code: "invalid_resize_seq", message: "resize sequence 必须从 1 开始".into() });
        }
        let holder = self.current_holder(channel_id, holder_epoch)?;
        match self.resize_cursors.get(&holder.client_instance_id) {
            None => Ok(SequencedDecision::Apply),
            Some(cursor) if resize_seq > cursor.seq => Ok(SequencedDecision::Apply),
            Some(cursor) if resize_seq == cursor.seq && cursor.rows == rows && cursor.cols == cols => Ok(SequencedDecision::Duplicate),
            Some(cursor) if resize_seq == cursor.seq => {
                Err(ControlError { code: "resize_seq_collision", message: "相同 resize sequence 携带了不同尺寸".into() })
            }
            Some(_) => Err(ControlError { code: "stale_resize", message: "resize sequence 已过期".into() }),
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
        let client_instance_id = self.current_holder(channel_id, holder_epoch)?.client_instance_id.clone();
        self.resize_cursors.insert(client_instance_id, ResizeCursor { seq: resize_seq, rows, cols });
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct CellStyle {
    fg: Color,
    bg: Color,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
}

impl Default for CellStyle {
    fn default() -> Self {
        Self { fg: Color::Default, bg: Color::Default, bold: false, dim: false, italic: false, underline: false, inverse: false }
    }
}

impl From<&Cell> for CellStyle {
    fn from(cell: &Cell) -> Self {
        Self {
            fg: cell.fgcolor(),
            bg: cell.bgcolor(),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        }
    }
}

#[derive(Debug, Clone)]
struct CellSnapshot {
    contents: String,
    wide: bool,
    continuation: bool,
    style: CellStyle,
}

#[derive(Debug, Clone)]
struct RowSnapshot {
    cells: Vec<CellSnapshot>,
    wrapped: bool,
}

fn capture_row(screen: &Screen, row: u16, cols: u16) -> RowSnapshot {
    let mut cells = Vec::with_capacity(usize::from(cols));
    for col in 0..cols {
        let cell = screen.cell(row, col);
        cells.push(match cell {
            Some(cell) => CellSnapshot {
                contents: cell.contents().to_string(),
                wide: cell.is_wide(),
                continuation: cell.is_wide_continuation(),
                style: CellStyle::from(cell),
            },
            None => CellSnapshot { contents: String::new(), wide: false, continuation: false, style: CellStyle::default() },
        });
    }
    RowSnapshot { cells, wrapped: screen.row_wrapped(row) }
}

fn capture_viewport(screen: &Screen) -> Vec<RowSnapshot> {
    let (rows, cols) = screen.size();
    (0..rows).map(|row| capture_row(screen, row, cols)).collect()
}

fn capture_complete_history(screen: &Screen, line_limit: usize, row_capacity: usize) -> Vec<RowSnapshot> {
    if screen.alternate_screen() || line_limit == 0 {
        return Vec::new();
    }
    let (_, cols) = screen.size();
    let mut view = screen.clone();
    view.set_scrollback(usize::MAX);
    let history_rows = view.scrollback();
    let mut rows = Vec::with_capacity(history_rows);
    for index in 0..history_rows {
        view.set_scrollback(history_rows - index);
        rows.push(capture_row(&view, 0, cols));
    }

    // vt100 的底层容量按 physical row 截断。容量打满时无法知道首 row 是否接续已丢前缀，
    // 因而保守丢到第一个 hard-line 结束点；对外 snapshot 永不从半条 logical line 开始。
    if history_rows == row_capacity {
        let safe_start = rows.iter().position(|row| !row.wrapped).map_or(rows.len(), |index| index + 1);
        rows.drain(..safe_start);
    }
    // history 尾部若仍 wrap 到 viewport，也不作为残缺 logical line 单独写入历史。
    let safe_end = rows.iter().rposition(|row| !row.wrapped).map_or(0, |index| index + 1);
    rows.truncate(safe_end);

    let logical_lines = rows.iter().filter(|row| !row.wrapped).count();
    if logical_lines > line_limit {
        let drop_lines = logical_lines - line_limit;
        let mut seen = 0;
        let mut start = 0;
        for (index, row) in rows.iter().enumerate() {
            if !row.wrapped {
                seen += 1;
                if seen == drop_lines {
                    start = index + 1;
                    break;
                }
            }
        }
        rows.drain(..start);
    }
    rows
}

fn render_normal_snapshot(screen: &Screen, line_limit: usize, row_capacity: usize) -> Vec<u8> {
    let history = capture_complete_history(screen, line_limit, row_capacity);
    let mut snapshot = b"\x1bc".to_vec();
    render_active_grid(&mut snapshot, screen, &history);
    snapshot
}

fn reflow_normal_snapshot(
    snapshot: &[u8],
    old_rows: u16,
    old_cols: u16,
    rows: u16,
    cols: u16,
    line_limit: usize,
    row_capacity: usize,
) -> Vec<u8> {
    let mut old = vt100::Parser::new(old_rows, old_cols, row_capacity);
    old.process(snapshot);
    let (cursor_row, cursor_col) = old.screen().cursor_position();
    // xterm 增高 viewport 时会先从 scrollback 拉回 physical rows，cursor 随 viewport 一起
    // 下移；单纯在新尺寸重放 ANSI 会把 cursor 固定在旧 viewport row，退出 alt 后少出空行。
    let history_rows = {
        let mut view = old.screen().clone();
        view.set_scrollback(usize::MAX);
        view.scrollback()
    };
    let pulled = rows.saturating_sub(old_rows).min(u16::try_from(history_rows).unwrap_or(u16::MAX));
    let target_row = cursor_row.saturating_add(pulled).min(rows.saturating_sub(1));
    let target_col = cursor_col.min(cols.saturating_sub(1));

    let mut parser = vt100::Parser::new(rows, cols, row_capacity);
    parser.process(snapshot);
    parser.process(format!("\x1b[{};{}H", target_row.saturating_add(1), target_col.saturating_add(1)).as_bytes());
    render_normal_snapshot(parser.screen(), line_limit, row_capacity)
}

fn render_active_grid(out: &mut Vec<u8>, screen: &Screen, history: &[RowSnapshot]) {
    let mut rows = Vec::with_capacity(history.len() + usize::from(screen.size().0));
    rows.extend_from_slice(history);
    rows.extend(capture_viewport(screen));
    for (index, row) in rows.iter().enumerate() {
        render_row(out, row);
        if !row.wrapped && index + 1 < rows.len() {
            out.extend_from_slice(b"\r\n");
        }
    }
    out.extend_from_slice(&screen.cursor_state_formatted());
    out.extend_from_slice(&screen.attributes_formatted());
    out.extend_from_slice(&screen.input_mode_formatted());
}

fn render_row(out: &mut Vec<u8>, row: &RowSnapshot) {
    let default = CellStyle::default();
    let end = if row.wrapped {
        row.cells.len()
    } else {
        row.cells
            .iter()
            .rposition(|cell| !cell.contents.is_empty() || cell.style != default)
            .map_or(0, |index| index + 1)
    };
    let mut style = CellStyle::default();
    emit_style(out, &style);
    let mut index = 0;
    while index < end {
        let cell = &row.cells[index];
        if cell.continuation {
            index += 1;
            continue;
        }
        if cell.style != style {
            emit_style(out, &cell.style);
            style = cell.style.clone();
        }
        if cell.contents.is_empty() {
            out.push(b' ');
        } else {
            out.extend_from_slice(cell.contents.as_bytes());
        }
        index += if cell.wide { 2 } else { 1 };
    }
    if style != default {
        emit_style(out, &default);
    }
    if end < row.cells.len() {
        // auto-wrap 在 viewport 底部滚动时，新 row 会继承当时的背景色。显式用默认属性擦掉
        // 未序列化的尾部 padding，既不把空白变成文字，也不改变 logical-line wrap。
        out.extend_from_slice(b"\x1b[K");
    }
}

fn emit_style(out: &mut Vec<u8>, style: &CellStyle) {
    let mut params = vec!["0".to_string()];
    if style.bold {
        params.push("1".into());
    }
    if style.dim {
        params.push("2".into());
    }
    if style.italic {
        params.push("3".into());
    }
    if style.underline {
        params.push("4".into());
    }
    if style.inverse {
        params.push("7".into());
    }
    push_color(&mut params, style.fg, false);
    push_color(&mut params, style.bg, true);
    out.extend_from_slice(format!("\x1b[{}m", params.join(";")).as_bytes());
}

fn push_color(params: &mut Vec<String>, color: Color, background: bool) {
    match color {
        Color::Default => {}
        Color::Idx(index) if index < 8 => params.push((if background { 40 + index } else { 30 + index }).to_string()),
        Color::Idx(index) if index < 16 => params.push((if background { 100 + index - 8 } else { 90 + index - 8 }).to_string()),
        Color::Idx(index) => params.push(format!("{};5;{index}", if background { 48 } else { 38 })),
        Color::Rgb(red, green, blue) => params.push(format!("{};2;{red};{green};{blue}", if background { 48 } else { 38 })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_screen_equivalent(actual: &Screen, expected: &Screen) {
        assert_eq!(actual.size(), expected.size());
        assert_eq!(actual.alternate_screen(), expected.alternate_screen());
        assert_eq!(actual.cursor_position(), expected.cursor_position());
        assert_eq!(actual.application_keypad(), expected.application_keypad());
        assert_eq!(actual.application_cursor(), expected.application_cursor());
        assert_eq!(actual.bracketed_paste(), expected.bracketed_paste());
        assert_eq!(actual.hide_cursor(), expected.hide_cursor());
        let (rows, cols) = actual.size();
        for row in 0..rows {
            assert_eq!(actual.row_wrapped(row), expected.row_wrapped(row), "row {row} wrap mismatch");
            for col in 0..cols {
                assert_eq!(actual.cell(row, col), expected.cell(row, col), "cell ({row}, {col}) mismatch");
            }
        }
    }

    fn restored(state: &TerminalState) -> vt100::Parser {
        let mut parser = vt100::Parser::new(state.rows, state.cols, state.history_row_capacity);
        parser.process(&state.snapshot());
        parser
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
        state.feed(bytes);
        state.resize(6, 30);
        state.feed(b"\r\nafter resize");
        let parser = restored(&state);
        assert_screen_equivalent(state.parser.screen(), parser.screen());
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
        assert_screen_equivalent(whole.parser.screen(), split.parser.screen());
        assert_eq!(whole.snapshot(), split.snapshot());
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
    }

    #[test]
    fn sessiond_title_survives_chunked_feed_and_resize() {
        let bytes = "\x1b]0;标题跨 chunk 不碎\x07".as_bytes();
        let mut state = TerminalState::new(4, 12, 8);
        for byte in bytes {
            state.feed(std::slice::from_ref(byte));
        }
        assert_eq!(state.title(), "标题跨 chunk 不碎");
        // resize 重建 parser（snapshot 重放不含 OSC），标题必须存续。
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
    }

    #[test]
    fn sessiond_vt_alt_screen_snapshot_restores_hidden_normal_screen() {
        let mut state = TerminalState::new(4, 18, 8);
        state.feed(b"normal survives\r\nsecond");
        state.feed(b"\x1b[?1049h\x1b[2J\x1b[Halt tui\x1b[?2004h");
        assert!(state.parser.screen().alternate_screen());

        let mut parser = restored(&state);
        assert_screen_equivalent(state.parser.screen(), parser.screen());

        state.feed(b"\x1b[?1049l");
        parser.process(b"\x1b[?1049l");
        assert_screen_equivalent(state.parser.screen(), parser.screen());
        assert!(state.parser.screen().contents().contains("normal survives"));
    }

    #[test]
    fn sessiond_vt_snapshot_clears_unserialized_trailing_padding() {
        let mut state = TerminalState::new(2, 8, 8);
        state.feed(b"first\r\n\x1b[48;5;24m1234567890\x1b[0m");
        state.resize(3, 10);
        let screen = state.parser.screen();
        assert!(screen.contents().contains("1234567890"));
        for row in 0..screen.size().0 {
            for col in 0..screen.size().1 {
                let cell = screen.cell(row, col).unwrap();
                if cell.contents().is_empty() {
                    assert_eq!(cell.bgcolor(), Color::Default, "cell ({row}, {col}) 保留了 reflow padding 背景色");
                }
            }
        }
        let snapshot = state.snapshot();
        assert!(snapshot.windows(b"\x1b[K".len()).any(|window| window == b"\x1b[K"));
        let mut parser = vt100::Parser::new(state.rows, state.cols, state.history_row_capacity);
        parser.process(&snapshot);
        assert_screen_equivalent(screen, parser.screen());
    }

    #[test]
    fn sessiond_vt_resize_while_alt_reflows_hidden_normal_screen() {
        let mut state = TerminalState::new(2, 8, 8);
        state.feed(b"first\r\n\x1b[48;5;24m1234567890\x1b[0m");
        state.feed(b"\x1b[?1049h\x1b[2J\x1b[Halt tui");
        state.resize(3, 10);

        let mut parser = restored(&state);
        assert!(parser.screen().alternate_screen());
        assert_screen_equivalent(state.parser.screen(), parser.screen());

        state.feed(b"\x1b[?1049l");
        parser.process(b"\x1b[?1049l");
        assert_screen_equivalent(state.parser.screen(), parser.screen());
        assert!(state.parser.screen().contents().contains("1234567890"));
        for row in 0..state.parser.screen().size().0 {
            for col in 0..state.parser.screen().size().1 {
                let cell = state.parser.screen().cell(row, col).unwrap();
                if cell.contents().is_empty() {
                    assert_eq!(cell.bgcolor(), Color::Default, "hidden normal cell ({row}, {col}) 保留了背景色");
                }
            }
        }
    }

    #[test]
    fn sessiond_vt_history_snapshot_keeps_complete_logical_lines() {
        let mut state = TerminalState::new(3, 10, 2);
        let mut bytes = vec![b'x'; 100];
        bytes.extend_from_slice(b"\r\none\r\ntwo\r\nthree\r\ncurrent");
        state.feed(&bytes);
        let selected = capture_complete_history(state.parser.screen(), 2, state.history_row_capacity);
        let hard_lines = selected.iter().filter(|row| !row.wrapped).count();
        assert!(hard_lines <= 2, "history exceeded logical-line limit: {hard_lines}");
        assert!(selected.last().is_none_or(|row| !row.wrapped), "history ended with a partial logical line");
        assert!(selected.iter().flat_map(|row| &row.cells).all(|cell| !cell.contents.contains('x')), "history began inside truncated long line");

        let snapshot = state.snapshot();
        let mut parser = vt100::Parser::new(3, 10, 16);
        parser.process(&snapshot);
        assert!(parser.screen().contents().contains("current"));
    }

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
        assert_eq!((resumed.replay[0].from_seq, resumed.replay[0].to_seq), (4, 5));

        let fallback = state.attach("channel-2", "client-1", 2, Some(4)).unwrap();
        assert_eq!(fallback.snapshot_seq, 5);
        assert!(fallback.ansi_snapshot.is_some());
        assert!(fallback.replay.is_empty());
        assert_eq!(fallback.holder_epoch, resumed.holder_epoch, "transport migration must not self-handoff");
    }

    #[test]
    fn sessiond_holder_migration_keeps_epoch_and_rejects_old_transport() {
        let mut state = SessionState::new(3, 12, 4);
        let first = state.attach("direct-1", "client-a", 1, None).unwrap();
        let migrated = state.attach("relay-2", "client-a", 2, None).unwrap();
        assert_eq!(migrated.holder_epoch, first.holder_epoch);
        assert!(migrated.detached.is_none(), "same logical client must not detach itself");
        assert_eq!(
            state.input_decision("direct-1", first.holder_epoch, 1, b"old").unwrap_err().code,
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
        assert_eq!(state.input_decision("channel-a", first.holder_epoch, 1, b"no").unwrap_err().code, "stale_holder");
    }

    #[test]
    fn sessiond_holder_rejects_stale_generation_after_another_client_takes_over() {
        let mut state = SessionState::new(3, 12, 4);
        state.attach("channel-a-3", "client-a", 3, None).unwrap();
        state.attach("channel-b-1", "client-b", 1, None).unwrap();

        assert_eq!(state.attach("channel-a-2", "client-a", 2, None).unwrap_err().code, "stale_transport");
        assert_eq!(state.attach("channel-a-other", "client-a", 3, None).unwrap_err().code, "generation_collision");
        assert_eq!(state.attach("channel-a-3", "client-a", 4, None).unwrap_err().code, "generation_collision");

        let current = state.attach("channel-a-4", "client-a", 4, None).unwrap();
        assert_eq!(current.holder_epoch, 3);
    }

    #[test]
    fn sessiond_holder_input_and_resize_sequences_are_idempotent() {
        let mut state = SessionState::new(3, 12, 4);
        let attached = state.attach("channel-a", "client-a", 1, None).unwrap();
        let epoch = attached.holder_epoch;

        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 0);
        assert_eq!(state.input_decision("channel-a", epoch, 2, b"gap").unwrap_err().code, "input_seq_gap");
        assert_eq!(state.commit_input("channel-a", epoch, 2, b"gap".to_vec()).unwrap_err().code, "input_commit_out_of_order");
        assert_eq!(state.input_decision("channel-a", epoch, 1, b"hello").unwrap(), SequencedDecision::Apply);
        state.commit_input("channel-a", epoch, 1, b"hello".to_vec()).unwrap();
        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 1);
        assert_eq!(state.input_decision("channel-a", epoch, 1, b"hello").unwrap(), SequencedDecision::Duplicate);
        assert_eq!(state.input_decision("channel-a", epoch, 1, b"changed").unwrap_err().code, "input_seq_collision");
        assert_eq!(state.input_decision("channel-a", epoch, 3, b"gap").unwrap_err().code, "input_seq_gap");
        assert_eq!(state.input_decision("channel-a", epoch, 2, b"next").unwrap(), SequencedDecision::Apply);
        state.commit_input("channel-a", epoch, 2, b"next".to_vec()).unwrap();
        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 2);
        assert_eq!(state.input_decision("channel-a", epoch, 1, b"hello").unwrap(), SequencedDecision::Duplicate);
        assert_eq!(state.input_decision("channel-a", epoch, 1, b"changed stale payload").unwrap(), SequencedDecision::Duplicate);

        assert_eq!(state.resize_decision("channel-a", epoch, 1, 40, 120).unwrap(), SequencedDecision::Apply);
        state.commit_resize("channel-a", epoch, 1, 40, 120).unwrap();
        assert_eq!(state.resize_decision("channel-a", epoch, 1, 40, 120).unwrap(), SequencedDecision::Duplicate);
        assert_eq!(state.resize_decision("channel-a", epoch, 1, 41, 120).unwrap_err().code, "resize_seq_collision");
        assert_eq!(state.resize_decision("channel-a", epoch, 3, 50, 140).unwrap(), SequencedDecision::Apply);
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
        assert!(state.feed(marker).is_empty(), "gapped subscriber must not receive later out-of-order deltas");
        assert_eq!(state.output_seq(), b"agent is working".len() as u64 + marker.len() as u64);

        let mut restored = vt100::Parser::new(4, 24, 32);
        restored.process(&state.snapshot());
        assert!(restored.screen().contents().contains("COMPLETED"));
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
        assert_eq!(state.input_decision("direct-1", first.holder_epoch, 1, b"stale").unwrap_err().code, "stale_transport");

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

}
