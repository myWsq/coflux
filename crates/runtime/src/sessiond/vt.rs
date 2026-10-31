//! The libghostty-vt terminal behind [`super::TerminalState`]: one dedicated thread per session
//! owns the `Terminal` (its types are `!Send`, so it is built inside the thread and never leaves
//! it) and answers requests in submission order.
//!
//! `feed` hands bytes over without waiting for the thread. The backlog is bounded twice: by
//! message count (a `sync_channel`) and by queued output bytes ([`FEED_BACKLOG_BYTES`]), so a
//! flood blocks the feeder only once the thread falls that far behind. Everything that reads the
//! terminal (render, resize, barrier) waits for its answer; because it travels the same channel
//! as the feeds, the answer always reflects every byte fed before it, which keeps a snapshot
//! exactly at the `output_seq` sessiond reports with it.
//!
//! libghostty's own replies (DA, DECRQM, XTVERSION, size and colour-scheme reports, clipboard)
//! never leave this thread: no reply-producing callback is registered, so the library drops
//! them. sessiond's only reply to the PTY is its own DA1 answer, decided by the output scanner.

use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use coflux_protocol::logln;
use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use libghostty_vt::render::CursorVisualStyle;
use libghostty_vt::screen::Screen;
use libghostty_vt::selection::Selection;
use libghostty_vt::snapshot::Decoder;
use libghostty_vt::style::{PaletteIndex, RgbColor, Style, StyleColor, Underline};
use libghostty_vt::terminal::{Mode, Point, PointCoordinate};
use libghostty_vt::{RenderState, Terminal};

/// Logical-line limit → scrollback budget: every logical line is budgeted as up to this many
/// physical rows, so narrow windows still hold `history_line_limit` lines that wrap.
pub(super) const HISTORY_WRAP_FACTOR: usize = 4;

/// Bytes of scrollback budgeted per cell. libghostty stores a styled cell in about 9-11 bytes
/// (measured at 60-300 columns, plan 20261030-sessiond-libghostty-vt gate check 5); 12 leaves
/// headroom for style and hyperlink tables. The resident cap of one session is therefore
/// `history_line_limit × HISTORY_WRAP_FACTOR × cols × 12` bytes (28.8 MB for 5,000 lines at 120
/// columns), about a third of the 32-byte cells the previous engine kept for as many rows. libghostty prunes
/// whole pages (~400 KB), so the cap is approximate by up to a page.
const HISTORY_BYTES_PER_CELL: usize = 12;

/// Output bytes queued for the terminal thread before `feed` blocks. A single larger chunk is
/// still accepted when nothing else is queued.
const FEED_BACKLOG_BYTES: usize = 4 * 1024 * 1024;

/// Requests queued for the terminal thread before a sender blocks, whatever their size.
const REQUEST_QUEUE_LEN: usize = 1024;

/// Unfinished VT input the terminal keeps replayable, so a snapshot clone (see
/// [`Engine::primary_from_clone`]) can be encoded in the middle of a sequence. A longer
/// unfinished sequence makes the clone unavailable; the primary half then degrades to a reset.
const CONTINUATION_MAX_BYTES: usize = 64 * 1024;

/// What a render request returns: the snapshot to replay into a fresh terminal of the same size,
/// and, while the alternate screen is active, the primary screen's own snapshot (its prefix).
pub(super) struct Rendered {
    pub(super) snapshot: Vec<u8>,
    pub(super) primary: Option<Vec<u8>>,
}

impl Rendered {
    /// The answer when the terminal is unavailable (construction failed or the thread is gone).
    fn blank() -> Self {
        Self {
            snapshot: b"\x1bc".to_vec(),
            primary: None,
        }
    }
}

enum Request {
    /// Output bytes, plus the offsets (relative to `bytes`) of the final byte of every DECSET
    /// naming mode 2027: the thread writes through each, then forces the mode off again.
    Feed {
        bytes: Vec<u8>,
        grapheme_resets: Vec<usize>,
    },
    Render {
        line_limit: usize,
        reply: SyncSender<Rendered>,
    },
    Resize {
        rows: u16,
        cols: u16,
        reply: SyncSender<()>,
    },
    Barrier {
        reply: SyncSender<()>,
    },
}

/// Queued feed bytes and whether the terminal thread is gone (a gone thread never drains).
#[derive(Default)]
struct Backlog {
    state: Mutex<(usize, bool)>,
    drained: Condvar,
}

impl Backlog {
    fn reserve(&self, len: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !state.1 && state.0 > 0 && state.0.saturating_add(len) > FEED_BACKLOG_BYTES {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        if !state.1 {
            state.0 = state.0.saturating_add(len);
        }
    }

    fn release(&self, len: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.0 = state.0.saturating_sub(len);
        self.drained.notify_all();
    }

    fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.1 = true;
        state.0 = 0;
        self.drained.notify_all();
    }
}

/// Closes the backlog when the terminal thread ends, including by unwinding, so a feeder
/// waiting on it never hangs.
struct CloseOnExit(Arc<Backlog>);

impl Drop for CloseOnExit {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Handle to one session's terminal thread. Dropping it closes the channel and joins the thread.
pub(super) struct VtHandle {
    tx: Option<SyncSender<Request>>,
    backlog: Arc<Backlog>,
    thread: Option<JoinHandle<()>>,
}

impl VtHandle {
    pub(super) fn spawn(rows: u16, cols: u16, history_line_limit: usize) -> Self {
        let (tx, rx) = sync_channel(REQUEST_QUEUE_LEN);
        let backlog = Arc::new(Backlog::default());
        let thread_backlog = backlog.clone();
        let spawned = std::thread::Builder::new()
            .name("sessiond-vt".into())
            .spawn(move || run(rx, thread_backlog, rows, cols, history_line_limit));
        match spawned {
            Ok(thread) => Self {
                tx: Some(tx),
                backlog,
                thread: Some(thread),
            },
            Err(err) => {
                logln!("[sessiond] terminal thread did not start: {err}");
                backlog.close();
                Self {
                    tx: None,
                    backlog,
                    thread: None,
                }
            }
        }
    }

    /// Queue output for the terminal without waiting for it to be applied.
    pub(super) fn feed(&self, bytes: Vec<u8>, grapheme_resets: Vec<usize>) {
        let Some(tx) = &self.tx else {
            return;
        };
        let len = bytes.len();
        self.backlog.reserve(len);
        if tx
            .send(Request::Feed {
                bytes,
                grapheme_resets,
            })
            .is_err()
        {
            self.backlog.release(len);
        }
    }

    pub(super) fn render(&self, line_limit: usize) -> Rendered {
        let (reply, answer) = sync_channel(1);
        self.ask(Request::Render { line_limit, reply }, answer)
            .unwrap_or_else(Rendered::blank)
    }

    pub(super) fn resize(&self, rows: u16, cols: u16) {
        let (reply, answer) = sync_channel(1);
        let _ = self.ask(Request::Resize { rows, cols, reply }, answer);
    }

    /// Wait until every request queued before this one has been applied.
    pub(super) fn barrier(&self) {
        let (reply, answer) = sync_channel(1);
        let _ = self.ask(Request::Barrier { reply }, answer);
    }

    fn ask<T>(&self, request: Request, answer: Receiver<T>) -> Option<T> {
        self.tx.as_ref()?.send(request).ok()?;
        answer.recv().ok()
    }
}

impl Drop for VtHandle {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(
    rx: Receiver<Request>,
    backlog: Arc<Backlog>,
    rows: u16,
    cols: u16,
    history_line_limit: usize,
) {
    let _close = CloseOnExit(backlog.clone());
    let mut engine = match Engine::new(rows, cols, history_line_limit) {
        Ok(engine) => Some(engine),
        Err(err) => {
            logln!("[sessiond] libghostty terminal unavailable ({rows}x{cols}): {err:?}");
            None
        }
    };
    for request in rx {
        match request {
            Request::Feed {
                bytes,
                grapheme_resets,
            } => {
                if let Some(engine) = engine.as_mut() {
                    engine.write(&bytes, &grapheme_resets);
                }
                backlog.release(bytes.len());
            }
            Request::Render { line_limit, reply } => {
                let rendered = engine
                    .as_mut()
                    .map_or_else(Rendered::blank, |engine| engine.render(line_limit));
                let _ = reply.send(rendered);
            }
            Request::Resize { rows, cols, reply } => {
                if let Some(engine) = engine.as_mut() {
                    engine.resize(rows, cols);
                }
                let _ = reply.send(());
            }
            Request::Barrier { reply } => {
                let _ = reply.send(());
            }
        }
    }
}

pub(super) type Term = Terminal<'static, 'static>;

/// The terminal and the policies sessiond applies to it. Lives only on the terminal thread
/// (sessiond's unit tests build one on theirs as the reference terminal).
pub(super) struct Engine {
    term: Term,
    history_line_limit: usize,
}

impl Engine {
    pub(super) fn new(
        rows: u16,
        cols: u16,
        history_line_limit: usize,
    ) -> libghostty_vt::error::Result<Self> {
        let mut term = Terminal::new(cols.max(1), rows.max(1))?;
        // No image data is ever buffered: every Kitty graphics command carrying data exceeds a
        // zero APC budget and is dropped, so transmissions never reach image storage.
        if let Err(err) = term.set_apc_max_bytes(Some(0)) {
            logln!("[sessiond] APC budget rejected: {err:?}");
        }
        if let Err(err) = term.set_glyph_protocol_enabled(false) {
            logln!("[sessiond] glyph protocol stays enabled: {err:?}");
        }
        if let Err(err) = term.set_continuation_max_bytes(CONTINUATION_MAX_BYTES) {
            logln!("[sessiond] continuation tracking unavailable: {err:?}");
        }
        // Mode 2027 is off by default; sessiond keeps it off (see `write`).
        let _ = term.set_mode(Mode::GRAPHEME_CLUSTER, false);
        let mut engine = Self {
            term,
            history_line_limit,
        };
        engine.apply_scrollback_cap(cols.max(1));
        Ok(engine)
    }

    /// The byte cap always replaces libghostty's built-in default; it scales with the width.
    fn apply_scrollback_cap(&mut self, cols: u16) {
        let cap = self
            .history_line_limit
            .saturating_mul(HISTORY_WRAP_FACTOR)
            .saturating_mul(usize::from(cols))
            .saturating_mul(HISTORY_BYTES_PER_CELL);
        let _ = self.term.set_scrollback_max_lines(None);
        if let Err(err) = self.term.set_scrollback_max_bytes(Some(cap)) {
            logln!("[sessiond] scrollback cap {cap} rejected: {err:?}");
        }
    }

    /// Widths stay per code point: after the final byte of every DECSET naming mode 2027 the mode
    /// is forced off again, before any later byte of the same write is processed.
    pub(super) fn write(&mut self, bytes: &[u8], grapheme_resets: &[usize]) {
        let mut start = 0;
        for &end in grapheme_resets {
            if end < start || end >= bytes.len() {
                continue;
            }
            self.term.vt_write(&bytes[start..=end]);
            let _ = self.term.set_mode(Mode::GRAPHEME_CLUSTER, false);
            start = end + 1;
        }
        if start < bytes.len() {
            self.term.vt_write(&bytes[start..]);
        }
    }

    /// Native resize: libghostty reflows the primary screen (the alternate screen does not reflow).
    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        let (rows, cols) = (rows.max(1), cols.max(1));
        if let Err(err) = self.term.resize(cols, rows, 0, 0) {
            logln!("[sessiond] terminal resize to {rows}x{cols} failed: {err:?}");
        }
        self.apply_scrollback_cap(cols);
    }

    #[cfg(test)]
    pub(super) fn terminal(&self) -> &Term {
        &self.term
    }

    pub(super) fn render(&mut self, line_limit: usize) -> Rendered {
        let alternate = matches!(self.term.active_screen(), Ok(Screen::Alternate));
        if !alternate {
            let mut snapshot = b"\x1bc".to_vec();
            snapshot.extend_from_slice(&format_newest(&self.term, line_limit, true));
            snapshot.extend_from_slice(&decscusr(&self.term));
            return Rendered {
                snapshot,
                primary: None,
            };
        }
        let primary = self.primary_from_clone(line_limit);
        let mut snapshot = primary.clone();
        snapshot.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
        snapshot.extend_from_slice(&format_screen(&self.term, true));
        snapshot.extend_from_slice(&decscusr(&self.term));
        Rendered {
            snapshot,
            primary: Some(primary),
        }
    }

    /// The primary screen's snapshot while the alternate screen is active. The live terminal is
    /// never switched: toggling screens copies the cursor and pen across and ends an open OSC 8
    /// link. Instead a clone (libghostty's binary snapshot, encoded and decoded) leaves the
    /// alternate screen with `?47l`, restores the cursor `?1049h` saved with DECRC, and its
    /// primary is formatted with modes off — the modes belong to the alternate half.
    fn primary_from_clone(&self, line_limit: usize) -> Vec<u8> {
        let mut primary = b"\x1bc".to_vec();
        let encoded = match self.term.encode_snapshot_alloc(None) {
            Ok(Some(bytes)) => bytes.to_vec(),
            Ok(None) => return primary,
            Err(err) => {
                logln!("[sessiond] primary screen clone unavailable: {err:?}");
                return primary;
            }
        };
        let clone: Option<Term> = Decoder::new_buf(&encoded)
            .and_then(|decoder| decoder.decode())
            .map_err(|err| logln!("[sessiond] primary screen clone did not decode: {err:?}"))
            .ok();
        if let Some(mut clone) = clone {
            clone.vt_write(b"\x1b[?47l\x1b8");
            primary.extend_from_slice(&format_newest(&clone, line_limit, false));
        }
        primary
    }
}

/// The formatter options of every snapshot: unwrap, cursor, style, scrolling region, hyperlink,
/// keyboard, Kitty keyboard, tab stops and charsets on; trim, palette and pwd off. `modes`
/// controls the program-set modes (off only for the primary half of an alternate-screen snapshot).
fn snapshot_options<'t, 's>(modes: bool) -> FormatterOptions<'t, 's> {
    FormatterOptions::new()
        .with_format(Format::Vt)
        .with_unwrap(true)
        .with_trim(false)
        .with_cursor(true)
        .with_style(true)
        .with_modes(modes)
        .with_scrolling_region(true)
        .with_hyperlink(true)
        .with_keyboard(true)
        .with_kitty_keyboard(true)
        .with_tabstops(true)
        .with_charsets(true)
        .with_palette(false)
        .with_pwd(false)
}

fn run_formatter(term: &Term, options: FormatterOptions<'_, '_>) -> Vec<u8> {
    Formatter::new(term, options)
        .and_then(|mut formatter| formatter.format_alloc(None).map(|bytes| bytes.to_vec()))
        .unwrap_or_else(|err| {
            logln!("[sessiond] terminal formatter failed: {err:?}");
            Vec::new()
        })
}

/// The whole active screen (used for the alternate screen, which has no scrollback).
fn format_screen(term: &Term, modes: bool) -> Vec<u8> {
    let start = term
        .scrollback_rows()
        .ok()
        .and_then(|rows| u32::try_from(rows).ok())
        .unwrap_or(0);
    repair_full_width_wraps(term, start, run_formatter(term, snapshot_options(modes)))
}

/// The newest `line_limit` logical lines of history plus the screen. A selection from the first
/// row of the oldest kept logical line to the last cell of the screen restricts the formatter.
fn format_newest(term: &Term, line_limit: usize, modes: bool) -> Vec<u8> {
    let (Ok(cols), Ok(total)) = (term.cols(), term.total_rows()) else {
        return Vec::new();
    };
    let Ok(total) = u32::try_from(total) else {
        return Vec::new();
    };
    if total == 0 || cols == 0 {
        return Vec::new();
    }
    let start = newest_start_row(term, line_limit);
    let selection = term
        .grid_ref(Point::Screen(PointCoordinate { x: 0, y: start }))
        .and_then(|from| {
            term.grid_ref(Point::Screen(PointCoordinate {
                x: cols - 1,
                y: total - 1,
            }))
            .map(|to| Selection::new(from, to, false))
        });
    match selection {
        Ok(selection) => repair_full_width_wraps(
            term,
            start,
            run_formatter(term, snapshot_options(modes).with_selection(&selection)),
        ),
        Err(err) => {
            logln!("[sessiond] snapshot selection unavailable: {err:?}");
            Vec::new()
        }
    }
}

/// Whether some soft-wrapped row from `start` on is followed by a row that begins with an empty
/// cell: the only place where [`repair_full_width_wraps`] can have something to do.
fn has_blank_led_continuation(term: &Term, start: u32) -> bool {
    let Some(total) = term
        .total_rows()
        .ok()
        .and_then(|rows| u32::try_from(rows).ok())
    else {
        return false;
    };
    (start..total.saturating_sub(1)).any(|y| {
        let wrapped = term
            .grid_ref(Point::Screen(PointCoordinate { x: 0, y }))
            .and_then(|grid| grid.row())
            .and_then(|row| row.is_wrapped())
            .unwrap_or(false);
        wrapped
            && !term
                .grid_ref(Point::Screen(PointCoordinate { x: 0, y: y + 1 }))
                .and_then(|grid| grid.cell())
                .and_then(|cell| cell.has_text())
                .unwrap_or(true)
    })
}

/// The formatter joins soft-wrapped rows (unwrap on) and relies on printing to wrap them again.
/// When a wrapped row is full, the replay's cursor sits on its last column with a wrap pending;
/// if the continuation row then begins with empty cells, the formatter steps over them (CUF) or
/// erases them with their background (ECH), neither of which wraps, so the replay overwrites the
/// row's last cell and loses both wrap flags. Replaying the output into a scratch terminal finds
/// every such step; in front of it a space performs the real wrap, BS returns to the first cell
/// of the continuation row, ECH (with the default pen) empties that cell again, and the pen is
/// restored. The replay then matches the terminal cell for cell, flags and styles included.
fn repair_full_width_wraps(term: &Term, start: u32, output: Vec<u8>) -> Vec<u8> {
    if !has_blank_led_continuation(term, start) {
        return output;
    }
    let (Ok(cols), Ok(rows)) = (term.cols(), term.rows()) else {
        return output;
    };
    let Ok(mut scratch) = Term::new(cols, rows) else {
        return output;
    };
    let _ = scratch.set_scrollback_max_bytes(None);
    let mut repaired = Vec::with_capacity(output.len() + 64);
    let mut written = 0;
    let mut from = 0;
    while let Some(step) = find_cursor_step(&output, from) {
        scratch.vt_write(&output[written..step]);
        repaired.extend_from_slice(&output[written..step]);
        written = step;
        if scratch.is_cursor_pending_wrap().unwrap_or(false) {
            let mut fix = b"\x1b[0m \x08\x1b[X".to_vec();
            if let Ok(pen) = scratch.cursor_style() {
                fix.extend_from_slice(&sgr(&pen));
            }
            scratch.vt_write(&fix);
            repaired.extend_from_slice(&fix);
        }
        from = step + 2;
    }
    repaired.extend_from_slice(&output[written..]);
    repaired
}

/// Offset of the next `ESC [ <digits> X` (ECH) or `ESC [ <digits> C` (CUF) at or after `from`.
/// The formatter's output carries no other strings an ESC could hide in: OSC 8 URIs end at ESC.
fn find_cursor_step(output: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at + 2 < output.len() {
        if output[at] == 0x1b && output[at + 1] == b'[' {
            let digits = output[at + 2..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let end = at + 2 + digits;
            if digits > 0 && matches!(output.get(end), Some(b'X' | b'C')) {
                return Some(at);
            }
        }
        at += 1;
    }
    None
}

/// SGR that sets exactly `style` from a reset pen.
fn sgr(style: &Style) -> Vec<u8> {
    let mut params: Vec<String> = Vec::new();
    for (on, param) in [
        (style.bold, "1"),
        (style.faint, "2"),
        (style.italic, "3"),
        (style.blink, "5"),
        (style.inverse, "7"),
        (style.invisible, "8"),
        (style.strikethrough, "9"),
        (style.overline, "53"),
    ] {
        if on {
            params.push(param.into());
        }
    }
    match style.underline {
        Underline::None => {}
        Underline::Double => params.push("4:2".into()),
        Underline::Curly => params.push("4:3".into()),
        Underline::Dotted => params.push("4:4".into()),
        Underline::Dashed => params.push("4:5".into()),
        _ => params.push("4".into()),
    }
    for (base, color) in [
        (38, style.fg_color),
        (48, style.bg_color),
        (58, style.underline_color),
    ] {
        match color {
            StyleColor::None => {}
            StyleColor::Palette(PaletteIndex(index)) => params.push(format!("{base};5;{index}")),
            StyleColor::Rgb(RgbColor { r, g, b }) => params.push(format!("{base};2;{r};{g};{b}")),
        }
    }
    let mut out = b"\x1b[0m".to_vec();
    for param in params {
        out.extend_from_slice(format!("\x1b[{param}m").as_bytes());
    }
    out
}

/// Screen-space row where the newest `line_limit` logical lines of history begin; the first
/// screen row when `line_limit` is 0 or there is no history. A logical line begins at a row that
/// is not a wrap continuation. When history holds fewer lines, the oldest complete one is used:
/// rows continuing a line whose start was pruned are never included.
fn newest_start_row(term: &Term, line_limit: usize) -> u32 {
    let history = term
        .scrollback_rows()
        .ok()
        .and_then(|rows| u32::try_from(rows).ok())
        .unwrap_or(0);
    if line_limit == 0 {
        return history;
    }
    let mut start = history;
    let mut seen = 0;
    let mut y = history;
    while y > 0 {
        y -= 1;
        let begins_line = term
            .grid_ref(Point::Screen(PointCoordinate { x: 0, y }))
            .and_then(|grid| grid.row())
            .and_then(|row| row.is_wrap_continuation())
            .map(|continuation| !continuation)
            .unwrap_or(false);
        if begins_line {
            start = y;
            seen += 1;
            if seen == line_limit {
                break;
            }
        }
    }
    start
}

/// DECSCUSR for the cursor shape, which the formatter does not emit. The blink state goes with
/// it; a block cursor needs nothing, because the formatter's mode 12 already carries its blink.
fn decscusr(term: &Term) -> Vec<u8> {
    let Ok(mut state) = RenderState::new() else {
        return Vec::new();
    };
    let Ok(snapshot) = state.update(term) else {
        return Vec::new();
    };
    let blinking = snapshot.cursor_blinking().unwrap_or(false);
    let base = match snapshot.cursor_visual_style() {
        Ok(CursorVisualStyle::Underline) => 3,
        Ok(CursorVisualStyle::Bar) => 5,
        _ => return Vec::new(),
    };
    format!("\x1b[{} q", if blinking { base } else { base + 1 }).into_bytes()
}
