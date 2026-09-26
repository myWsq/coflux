//! Secret custody for agents (plan 20260926-agent-secret-input).
//!
//! An agent running in a coflux terminal sometimes needs a value from the user (an API key, a
//! database password) for a **non-interactive** destination. The agent never receives the value:
//! it runs `coflux secret ask NAME`, the user types the value on a desktop, the desktop hands it to
//! this worker over the end-to-end Device channel, and the agent only learns
//! `provided` / `declined` / `cancelled`. Every later use of the value is delegated back to the
//! worker (`coflux secret exec` releases it to the CLI of the owning session, `coflux secret
//! inject` makes the worker write a dotenv entry itself).
//!
//! Custody rules this module enforces:
//! - values live only in this process's memory, keyed by the session (terminal) that asked; they
//!   are never written to disk, logged, sent to the supervisor or the center, and never appear in
//!   `Debug` output ([`SecretBytes`] prints `***` and zeroes its buffer on drop);
//! - a value belongs to its session and is dropped (zeroed) when that session leaves the worker's
//!   live table ([`SecretVault::session_ended`], called from `DeviceRuntime::session_exited`, which
//!   every removal path goes through), and on a periodic sweep against the live table;
//! - the redaction set is every value any session currently holds plus values replaced by a
//!   re-ask, until their session ends ([`SecretVault::redact`]); it is applied to every snapshot
//!   that leaves toward an agent or the center.
//!
//! Pending-request metadata (never the value) is published to the center as a full idempotent
//! [`wire::SecretRequests`] snapshot on every change, the same shape as `SessionAgents`.

pub mod dotenv;
pub mod socket;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use coflux_protocol::wire::{self, daemon_to_server, SecretAnswerKind, SecretAnswerStatus};
use prost::Message as _;
use rand_core::{OsRng, RngCore};
use tokio::sync::{mpsc, oneshot};

use crate::WsOut;

/// Redaction marker written in place of every held value.
pub const REDACTED: &[u8] = b"***";
/// Upper bound on one value typed by the user.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
/// Upper bound on the agent-written reason shown on the card.
pub const MAX_REASON_CHARS: usize = 500;
/// Pending requests per session and in the whole worker: a runaway agent cannot flood the
/// desktops with cards.
const PENDING_PER_SESSION: usize = 4;
const PENDING_TOTAL: usize = 64;
/// Values held per session.
const VALUES_PER_SESSION: usize = 64;
/// How many settled request ids are remembered to answer late or duplicate answers precisely.
const SETTLED_MEMORY: usize = 256;

/// Bytes of a secret. Zeroed on drop; `Debug` never prints the content.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Appends to the buffer. Callers pre-reserve capacity so the buffer is not reallocated
    /// (a reallocation would leave an unzeroed copy behind).
    pub fn extend_from_slice(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self(Vec::with_capacity(capacity))
    }
}

impl Clone for SecretBytes {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes(***)")
    }
}

/// Overwrite the whole allocation (length and spare capacity) with zeros in a way the optimizer
/// may not elide.
pub fn wipe(buffer: &mut Vec<u8>) {
    let capacity = buffer.capacity();
    let pointer = buffer.as_mut_ptr();
    for offset in 0..capacity {
        // SAFETY: `offset < capacity`, the allocation is owned by `buffer`, and u8 has no
        // invalid bit patterns, so writing into spare capacity is sound.
        unsafe { std::ptr::write_volatile(pointer.add(offset), 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    buffer.clear();
}

/// Environment-variable style name: `[A-Za-z_][A-Za-z0-9_]*`, at most 128 bytes.
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// How a pending `ask` ended, as the agent sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskOutcome {
    Provided,
    Declined,
    Cancelled(CancelReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    /// The user closed the card.
    Closed,
    /// Nobody answered before the deadline.
    Timeout,
    /// The requesting terminal ended while the request was pending.
    SessionEnded,
}

impl AskOutcome {
    pub fn word(self) -> &'static str {
        match self {
            Self::Provided => "provided",
            Self::Declined => "declined",
            Self::Cancelled(_) => "cancelled",
        }
    }

    /// Why a `cancelled` happened, for the CLI's stderr hint; empty for the other outcomes.
    pub fn detail(self) -> &'static str {
        match self {
            Self::Cancelled(CancelReason::Closed) => "closed",
            Self::Cancelled(CancelReason::Timeout) => "timeout",
            Self::Cancelled(CancelReason::SessionEnded) => "session_ended",
            _ => "",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Settled {
    Answered,
    Expired,
}

struct Pending {
    session_id: String,
    task_id: String,
    name: String,
    reason: String,
    created_at: f64,
    expires_at: f64,
    waiter: oneshot::Sender<AskOutcome>,
}

#[derive(Default)]
struct Held {
    values: HashMap<String, SecretBytes>,
    /// Values replaced by a re-ask: no longer usable, still redacted until the session ends.
    retired: Vec<SecretBytes>,
}

#[derive(Default)]
struct VaultState {
    sessions: HashMap<String, Held>,
    pending: HashMap<String, Pending>,
    settled: VecDeque<(String, Settled)>,
}

impl VaultState {
    fn remember(&mut self, request_id: String, settled: Settled) {
        if self.settled.len() >= SETTLED_MEMORY {
            self.settled.pop_front();
        }
        self.settled.push_back((request_id, settled));
    }

    fn settled(&self, request_id: &str) -> Option<Settled> {
        self.settled
            .iter()
            .rev()
            .find(|(id, _)| id == request_id)
            .map(|(_, settled)| *settled)
    }

    fn snapshot(&self) -> Vec<wire::SecretRequestRef> {
        let mut requests: Vec<wire::SecretRequestRef> = self
            .pending
            .iter()
            .map(|(request_id, pending)| wire::SecretRequestRef {
                request_id: request_id.clone(),
                session_id: pending.session_id.clone(),
                task_id: pending.task_id.clone(),
                name: pending.name.clone(),
                reason: pending.reason.clone(),
                created_at: pending.created_at,
                expires_at: pending.expires_at,
            })
            .collect();
        // Stable order: the center compares snapshots and clients render cards in ask order.
        requests.sort_by(|a, b| {
            a.created_at
                .total_cmp(&b.created_at)
                .then_with(|| a.request_id.cmp(&b.request_id))
        });
        requests
    }
}

/// A new pending request, returned to the socket handler that waits on it.
pub struct AskTicket {
    pub request_id: String,
    pub outcome: oneshot::Receiver<AskOutcome>,
}

pub struct SecretVault {
    state: Mutex<VaultState>,
    to_server: mpsc::Sender<WsOut>,
}

impl SecretVault {
    pub fn new(to_server: mpsc::Sender<WsOut>) -> Self {
        Self {
            state: Mutex::new(VaultState::default()),
            to_server,
        }
    }

    /// Queue the current pending snapshot for the center. Called with the vault lock held by the
    /// mutators, so snapshots enter the outbound queue in the order they were taken; a dropped
    /// snapshot (full queue) is healed by the next change or the unconditional re-send after
    /// authentication.
    fn publish_locked(&self, state: &VaultState) {
        let envelope = wire::DaemonToServer {
            payload: Some(daemon_to_server::Payload::SecretRequests(
                wire::SecretRequests {
                    requests: state.snapshot(),
                },
            )),
        };
        let _ = self.to_server.try_send(envelope.encode_to_vec());
    }

    /// Unconditional re-send (after authentication, the center's copy is memory-only).
    pub fn publish(&self) {
        let state = self.state.lock().unwrap();
        self.publish_locked(&state);
    }

    /// Register a pending `ask` for `session_id`.
    pub fn begin_ask(
        &self,
        session_id: &str,
        task_id: &str,
        name: &str,
        reason: &str,
        timeout: Duration,
    ) -> Result<AskTicket, String> {
        let mut state = self.state.lock().unwrap();
        if state.pending.len() >= PENDING_TOTAL {
            return Err("too many secret requests are waiting on this device; answer or cancel some first".into());
        }
        let mut in_session = 0;
        for pending in state.pending.values() {
            if pending.session_id != session_id {
                continue;
            }
            if pending.name == name {
                return Err(format!(
                    "a request for {name} is already waiting in this terminal; wait for it or stop that command first"
                ));
            }
            in_session += 1;
        }
        if in_session >= PENDING_PER_SESSION {
            return Err("too many secret requests are waiting in this terminal".into());
        }
        let request_id = loop {
            let mut random = [0u8; 16];
            OsRng.fill_bytes(&mut random);
            let candidate = format!("secret-{}", hex::encode(random));
            if !state.pending.contains_key(&candidate) {
                break candidate;
            }
        };
        let created_at = epoch_ms();
        let (waiter, outcome) = oneshot::channel();
        state.pending.insert(
            request_id.clone(),
            Pending {
                session_id: session_id.to_string(),
                task_id: task_id.to_string(),
                name: name.to_string(),
                reason: reason.to_string(),
                created_at,
                expires_at: created_at + timeout.as_millis() as f64,
                waiter,
            },
        );
        self.publish_locked(&state);
        Ok(AskTicket {
            request_id,
            outcome,
        })
    }

    /// The asking CLI stopped waiting (deadline, Ctrl-C, killed): drop the request so every card
    /// closes. Returns false when an answer already settled it; the caller then reads the outcome
    /// that was sent.
    pub fn withdraw(&self, request_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(pending) = state.pending.remove(request_id) else {
            return false;
        };
        let _ = pending.waiter.send(AskOutcome::Cancelled(CancelReason::Timeout));
        state.remember(request_id.to_string(), Settled::Expired);
        self.publish_locked(&state);
        true
    }

    /// A desktop's answer. First answer wins; `value` is only used for PROVIDE and is dropped
    /// (zeroed) otherwise.
    pub fn answer(
        &self,
        request_id: &str,
        kind: SecretAnswerKind,
        value: SecretBytes,
    ) -> SecretAnswerStatus {
        let valid = match kind {
            SecretAnswerKind::Provide => {
                !value.is_empty()
                    && value.len() <= MAX_VALUE_BYTES
                    && !value.as_bytes().contains(&0)
                    && std::str::from_utf8(value.as_bytes()).is_ok()
            }
            SecretAnswerKind::Decline | SecretAnswerKind::Cancel => value.is_empty(),
            SecretAnswerKind::Unspecified => false,
        };
        let mut state = self.state.lock().unwrap();
        if !state.pending.contains_key(request_id) {
            return match state.settled(request_id) {
                Some(Settled::Answered) => SecretAnswerStatus::AlreadyAnswered,
                Some(Settled::Expired) => SecretAnswerStatus::Expired,
                None => SecretAnswerStatus::UnknownRequest,
            };
        }
        if !valid {
            return SecretAnswerStatus::Invalid;
        }
        let pending = state.pending.remove(request_id).unwrap();
        let outcome = match kind {
            SecretAnswerKind::Provide => {
                let held = state.sessions.entry(pending.session_id.clone()).or_default();
                if !held.values.contains_key(&pending.name) && held.values.len() >= VALUES_PER_SESSION
                {
                    // Keep the request answerable by a later, smaller set; tell the desktop now.
                    state.pending.insert(request_id.to_string(), pending);
                    return SecretAnswerStatus::Invalid;
                }
                if let Some(previous) = held.values.insert(pending.name.clone(), value) {
                    held.retired.push(previous);
                }
                AskOutcome::Provided
            }
            SecretAnswerKind::Decline => AskOutcome::Declined,
            _ => AskOutcome::Cancelled(CancelReason::Closed),
        };
        let _ = pending.waiter.send(outcome);
        state.remember(request_id.to_string(), Settled::Answered);
        self.publish_locked(&state);
        SecretAnswerStatus::Accepted
    }

    /// The session left the worker's live table: zero and drop its values, end its pending
    /// requests as `cancelled`.
    pub fn session_ended(&self, session_id: &str) {
        let mut state = self.state.lock().unwrap();
        let dropped_values = state.sessions.remove(session_id).is_some();
        let ended: Vec<String> = state
            .pending
            .iter()
            .filter(|(_, pending)| pending.session_id == session_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in &ended {
            if let Some(pending) = state.pending.remove(request_id) {
                let _ = pending
                    .waiter
                    .send(AskOutcome::Cancelled(CancelReason::SessionEnded));
            }
            state.remember(request_id.clone(), Settled::Expired);
        }
        if !ended.is_empty() {
            self.publish_locked(&state);
        }
        drop(state);
        if dropped_values {
            coflux_protocol::logln!("[worker] secret values of session {session_id} dropped");
        }
    }

    /// Safety net against a missed removal path: forget every session that is not live.
    pub fn retain_sessions(&self, live: &HashSet<String>) {
        let stale: Vec<String> = {
            let state = self.state.lock().unwrap();
            state
                .sessions
                .keys()
                .chain(state.pending.values().map(|pending| &pending.session_id))
                .filter(|session_id| !live.contains(*session_id))
                .cloned()
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        };
        for session_id in stale {
            self.session_ended(&session_id);
        }
    }

    /// Whether `session_id` holds a value for `name`.
    #[cfg(test)]
    pub fn holds(&self, session_id: &str, name: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .sessions
            .get(session_id)
            .is_some_and(|held| held.values.contains_key(name))
    }

    /// A private copy of one value for the worker's own use (dotenv injection). Zeroed on drop.
    pub fn clone_value(&self, session_id: &str, name: &str) -> Option<SecretBytes> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .get(session_id)
            .and_then(|held| held.values.get(name))
            .cloned()
    }

    /// Serialize the `release` reply for `names` of `session_id` straight into a zeroing buffer:
    /// `{"ok":true,"values":{"NAME":"value",…}}\n`. `Err` lists the names that were never
    /// provided in this session.
    pub fn release_reply(&self, session_id: &str, names: &[String]) -> Result<SecretBytes, Vec<String>> {
        let state = self.state.lock().unwrap();
        let held = state.sessions.get(session_id);
        let missing: Vec<String> = names
            .iter()
            .filter(|name| held.is_none_or(|held| !held.values.contains_key(*name)))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(missing);
        }
        let held = held.expect("checked above");
        // Worst case every byte is escaped as \u00XX (6 bytes); reserve it all up front so the
        // buffer never reallocates and leaves a copy behind.
        let capacity = 64
            + names
                .iter()
                .map(|name| name.len() + 8 + held.values[name].len() * 6)
                .sum::<usize>();
        let mut out = SecretBytes::with_capacity(capacity);
        out.extend_from_slice(b"{\"ok\":true,\"values\":{");
        for (index, name) in names.iter().enumerate() {
            if index > 0 {
                out.extend_from_slice(b",");
            }
            write_json_string(&mut out, name.as_bytes());
            out.extend_from_slice(b":");
            write_json_string(&mut out, held.values[name].as_bytes());
        }
        out.extend_from_slice(b"}}\n");
        Ok(out)
    }

    /// Replace every occurrence of every held value (current and retired, across all sessions)
    /// with `***`. Longer values win where values overlap. Borrowed when nothing matched.
    pub fn redact<'a>(&self, input: &'a [u8]) -> Cow<'a, [u8]> {
        let state = self.state.lock().unwrap();
        let mut values: Vec<&[u8]> = state
            .sessions
            .values()
            .flat_map(|held| {
                held.values
                    .values()
                    .chain(held.retired.iter())
                    .map(SecretBytes::as_bytes)
            })
            .filter(|value| !value.is_empty())
            .collect();
        if values.is_empty() {
            return Cow::Borrowed(input);
        }
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        values.dedup();
        redact_with(input, &values)
    }
}

/// Literal byte-match redaction over a fixed value set (longest first).
fn redact_with<'a>(input: &'a [u8], values: &[&[u8]]) -> Cow<'a, [u8]> {
    let mut output: Option<Vec<u8>> = None;
    let mut index = 0;
    let mut copied_until = 0;
    while index < input.len() {
        let rest = &input[index..];
        let matched = values
            .iter()
            .find(|value| rest.starts_with(value))
            .map(|value| value.len());
        match matched {
            Some(length) => {
                let out = output.get_or_insert_with(|| Vec::with_capacity(input.len()));
                out.extend_from_slice(&input[copied_until..index]);
                out.extend_from_slice(REDACTED);
                index += length;
                copied_until = index;
            }
            None => index += 1,
        }
    }
    match output {
        None => Cow::Borrowed(input),
        Some(mut out) => {
            out.extend_from_slice(&input[copied_until..]);
            Cow::Owned(out)
        }
    }
}

/// JSON string literal for arbitrary UTF-8 bytes, written without intermediate allocations.
fn write_json_string(out: &mut SecretBytes, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.extend_from_slice(b"\"");
    for &byte in bytes {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0x00..=0x1f | 0x7f => out.extend_from_slice(&[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(byte >> 4) as usize],
                HEX[(byte & 0xf) as usize],
            ]),
            _ => out.extend_from_slice(&[byte]),
        }
    }
    out.extend_from_slice(b"\"");
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (SecretVault, mpsc::Receiver<WsOut>) {
        let (tx, rx) = mpsc::channel(64);
        (SecretVault::new(tx), rx)
    }

    fn provide(vault: &SecretVault, session: &str, name: &str, value: &str) {
        let ticket = vault
            .begin_ask(session, "task", name, "why", Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            vault.answer(
                &ticket.request_id,
                SecretAnswerKind::Provide,
                SecretBytes::new(value.as_bytes().to_vec())
            ),
            SecretAnswerStatus::Accepted
        );
    }

    #[test]
    fn debug_never_prints_the_value() {
        let secret = SecretBytes::new(b"hunter2".to_vec());
        assert_eq!(format!("{secret:?}"), "SecretBytes(***)");
    }

    #[test]
    fn names_are_environment_variable_names() {
        assert!(valid_name("OPENAI_API_KEY"));
        assert!(valid_name("_x1"));
        assert!(!valid_name(""));
        assert!(!valid_name("1ABC"));
        assert!(!valid_name("A-B"));
        assert!(!valid_name("A B"));
        assert!(!valid_name(&"A".repeat(129)));
    }

    #[test]
    fn first_answer_wins_and_later_ones_are_told_so() {
        let (vault, _rx) = vault();
        let mut ticket = vault
            .begin_ask("s1", "t1", "TOKEN", "deploy", Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            vault.answer(&ticket.request_id, SecretAnswerKind::Decline, SecretBytes::new(Vec::new())),
            SecretAnswerStatus::Accepted
        );
        assert_eq!(ticket.outcome.try_recv().unwrap(), AskOutcome::Declined);
        assert_eq!(
            vault.answer(
                &ticket.request_id,
                SecretAnswerKind::Provide,
                SecretBytes::new(b"late".to_vec())
            ),
            SecretAnswerStatus::AlreadyAnswered
        );
        assert!(!vault.holds("s1", "TOKEN"));
        assert_eq!(
            vault.answer("secret-unknown", SecretAnswerKind::Decline, SecretBytes::new(Vec::new())),
            SecretAnswerStatus::UnknownRequest
        );
    }

    #[test]
    fn withdrawn_and_ended_requests_answer_expired() {
        let (vault, _rx) = vault();
        let ticket = vault
            .begin_ask("s1", "t1", "A", "r", Duration::from_secs(60))
            .unwrap();
        assert!(vault.withdraw(&ticket.request_id));
        assert_eq!(
            vault.answer(&ticket.request_id, SecretAnswerKind::Decline, SecretBytes::new(Vec::new())),
            SecretAnswerStatus::Expired
        );
        let mut ticket = vault
            .begin_ask("s2", "t2", "B", "r", Duration::from_secs(60))
            .unwrap();
        vault.session_ended("s2");
        assert_eq!(
            ticket.outcome.try_recv().unwrap(),
            AskOutcome::Cancelled(CancelReason::SessionEnded)
        );
    }

    #[test]
    fn invalid_answers_keep_the_request_pending() {
        let (vault, _rx) = vault();
        let ticket = vault
            .begin_ask("s1", "t1", "A", "r", Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            vault.answer(&ticket.request_id, SecretAnswerKind::Provide, SecretBytes::new(Vec::new())),
            SecretAnswerStatus::Invalid
        );
        assert_eq!(
            vault.answer(
                &ticket.request_id,
                SecretAnswerKind::Decline,
                SecretBytes::new(b"x".to_vec())
            ),
            SecretAnswerStatus::Invalid
        );
        assert_eq!(
            vault.answer(
                &ticket.request_id,
                SecretAnswerKind::Provide,
                SecretBytes::new(b"ok".to_vec())
            ),
            SecretAnswerStatus::Accepted
        );
    }

    #[test]
    fn duplicate_pending_name_in_one_session_is_refused() {
        let (vault, _rx) = vault();
        let _first = vault
            .begin_ask("s1", "t1", "A", "r", Duration::from_secs(60))
            .unwrap();
        assert!(vault
            .begin_ask("s1", "t1", "A", "r", Duration::from_secs(60))
            .is_err());
        assert!(vault
            .begin_ask("s2", "t2", "A", "r", Duration::from_secs(60))
            .is_ok());
    }

    #[test]
    fn values_belong_to_their_session_and_end_with_it() {
        let (vault, _rx) = vault();
        provide(&vault, "s1", "TOKEN", "abc123");
        assert!(vault.holds("s1", "TOKEN"));
        assert!(!vault.holds("s2", "TOKEN"));
        assert!(vault
            .release_reply("s2", &["TOKEN".to_string()])
            .is_err());
        vault.session_ended("s1");
        assert!(!vault.holds("s1", "TOKEN"));
        assert_eq!(vault.redact(b"abc123").as_ref(), b"abc123");
    }

    #[test]
    fn retain_sessions_drops_values_of_sessions_no_longer_live() {
        let (vault, _rx) = vault();
        provide(&vault, "s1", "A", "value-one");
        provide(&vault, "s2", "B", "value-two");
        vault.retain_sessions(&HashSet::from(["s2".to_string()]));
        assert!(!vault.holds("s1", "A"));
        assert!(vault.holds("s2", "B"));
    }

    #[test]
    fn redaction_covers_every_session_and_replaced_values() {
        let (vault, _rx) = vault();
        provide(&vault, "s1", "A", "first-secret");
        provide(&vault, "s1", "A", "second-secret");
        provide(&vault, "s2", "B", "other-secret");
        let text = b"x first-secret y second-secret z other-secret";
        assert_eq!(vault.redact(text).as_ref(), b"x *** y *** z ***");
        assert!(matches!(vault.redact(b"nothing here"), Cow::Borrowed(_)));
    }

    #[test]
    fn longer_values_win_on_overlap() {
        let values: Vec<&[u8]> = vec![&b"abcdef"[..], &b"abc"[..]];
        assert_eq!(redact_with(b"abcdefabc", &values).as_ref(), b"******");
    }

    #[test]
    fn release_reply_is_json_with_escaped_values() {
        let (vault, _rx) = vault();
        provide(&vault, "s1", "A", "q\"u\\o\nte");
        let reply = vault.release_reply("s1", &["A".to_string()]).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(reply.as_bytes()).unwrap();
        assert_eq!(parsed["values"]["A"], "q\"u\\o\nte");
        assert_eq!(
            vault.release_reply("s1", &["A".to_string(), "MISSING".to_string()]).err(),
            Some(vec!["MISSING".to_string()])
        );
    }

    #[test]
    fn snapshots_carry_metadata_only() {
        let (vault, mut rx) = vault();
        let ticket = vault
            .begin_ask("s1", "t1", "TOKEN", "deploy", Duration::from_secs(60))
            .unwrap();
        let bytes = rx.try_recv().unwrap();
        let envelope = wire::DaemonToServer::decode(bytes.as_slice()).unwrap();
        let Some(daemon_to_server::Payload::SecretRequests(snapshot)) = envelope.payload else {
            panic!("expected a SecretRequests snapshot");
        };
        assert_eq!(snapshot.requests.len(), 1);
        assert_eq!(snapshot.requests[0].request_id, ticket.request_id);
        assert_eq!(snapshot.requests[0].name, "TOKEN");
        vault.answer(
            &ticket.request_id,
            SecretAnswerKind::Provide,
            SecretBytes::new(b"top-secret-value".to_vec()),
        );
        let bytes = rx.try_recv().unwrap();
        assert!(
            !bytes.windows(16).any(|window| window == b"top-secret-value"),
            "the snapshot must never carry the value"
        );
        let envelope = wire::DaemonToServer::decode(bytes.as_slice()).unwrap();
        let Some(daemon_to_server::Payload::SecretRequests(snapshot)) = envelope.payload else {
            panic!("expected a SecretRequests snapshot");
        };
        assert!(snapshot.requests.is_empty());
    }
}
