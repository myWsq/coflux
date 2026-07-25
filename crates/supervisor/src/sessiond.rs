//! sessiond 的纯状态核心：VT grid/history 与规范化 ANSI snapshot。
//!
//! 本模块不持有 PTY/网络对象，单测可以把生成的 ANSI snapshot 喂给第二个 `vt100::Parser`
//! 做状态等价验证。PTY 生命周期与 Device channel 路由留在 `sessions.rs`。

use vt100::{Cell, Color, Screen};

const HISTORY_WRAP_FACTOR: usize = 4;

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

pub struct TerminalState {
    parser: vt100::Parser,
    rows: u16,
    cols: u16,
    history_line_limit: usize,
    history_row_capacity: usize,
    mode_scanner: DecModeScanner,
    /// 进入 alt screen 前的完整主屏 snapshot；退出 alt 后由 vt100 内部主 grid 接回。
    normal_before_alt: Option<Vec<u8>>,
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16, history_line_limit: usize) -> Self {
        let history_row_capacity = history_line_limit.saturating_mul(HISTORY_WRAP_FACTOR);
        Self {
            parser: vt100::Parser::new(rows, cols, history_row_capacity),
            rows,
            cols,
            history_line_limit,
            history_row_capacity,
            mode_scanner: DecModeScanner::default(),
            normal_before_alt: None,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
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
        self.rows = rows;
        self.cols = cols;
        self.parser.screen_mut().set_size(rows, cols);
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

}
