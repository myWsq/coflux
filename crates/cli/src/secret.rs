//! `coflux secret ask|exec|inject` (plan 20260926-agent-secret-input): an agent in a coflux terminal
//! obtains a secret from the user without the value entering its context.
//!
//! - `ask NAME --reason "<why>" [--timeout <seconds>]` blocks until the user answers on a desktop
//!   or the timeout passes, then prints exactly one word: `provided`, `declined` or `cancelled`.
//! - `exec NAME [NAME…] -- <cmd> [args…]` runs the command with each value in a same-name
//!   environment variable; every occurrence of a value in the child's stdout/stderr is replaced
//!   with `***`, and the child's exit code is passed through.
//! - `inject NAME --file <path> [--key K]` has the worker write `K=value` into a dotenv file inside
//!   the caller's workspace; the value never reaches this process.
//!
//! Everything travels over the worker's kernel-attested socket `$COFLUX_HOME/ipc/secret.sock`
//! (`crates/worker/src/secret/socket.rs` holds the wire format), never over the loopback `/agent`
//! endpoint: the worker identifies the caller by the pid the kernel reports for this connection,
//! so the request carries none. The path is derived from `COFLUX_HOME` (default `~/.coflux`), not
//! from a PTY variable, so terminals opened before a worker upgrade still find it.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::die;

/// Mirrors `SOCKET_DIR` / `SOCKET_FILE` in `crates/worker/src/secret/socket.rs`.
const SOCKET_DIR: &str = "ipc";
const SOCKET_FILE: &str = "secret.sock";
const DEFAULT_ASK_TIMEOUT_SECS: u64 = 10 * 60;
const MAX_ASK_TIMEOUT_SECS: u64 = 60 * 60;
/// Grace on top of the ask timeout before this side stops waiting for the worker's reply.
const ASK_REPLY_GRACE: Duration = Duration::from_secs(60);
/// Bound on the short request/reply exchanges (release, inject).
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const REDACTED: &[u8] = b"***";

pub const HELP: &str = "coflux secret — get a secret from the user without it entering your context

  coflux secret ask NAME --reason \"<why>\" [--timeout <seconds>]
                          Ask the user (on their Coflux desktop) for a value such as an API key.
                          Blocks until they answer or the timeout passes (default 600 s) and
                          prints exactly one word: provided | declined | cancelled. Exit status
                          is 0 only for provided. Asking again for a NAME replaces its value.
  coflux secret exec NAME [NAME…] -- <cmd> [args…]
                          Run a command with each value in a same-name environment variable.
                          Every occurrence of a value in its stdout/stderr is shown as ***; the
                          command's exit status is passed through.
  coflux secret inject NAME --file <path> [--key KEY]
                          Insert or update KEY=value (KEY defaults to NAME) in a dotenv file
                          inside this terminal's workspace. Prints only that the file was written.

Values belong to the terminal that asked, live only in the coflux daemon's memory, and end with
that terminal. Only non-interactive destinations: for a password prompt (ssh, sudo) open a terminal
the user can take over instead. Never ask the user to paste a secret into the chat.";

pub fn run(args: &[String]) {
    let Some(sub) = args.first() else {
        println!("{HELP}");
        return;
    };
    match sub.as_str() {
        "ask" => ask(&args[1..]),
        "exec" => exec(&args[1..]),
        "inject" => inject(&args[1..]),
        "help" | "--help" | "-h" => println!("{HELP}"),
        other => die(&format!("unknown secret command: {other}\n\n{HELP}")),
    }
}

/// Options of one `secret` subcommand: positionals, `--opt value` / `--opt=value`, and, for
/// `exec`, everything after `--` as the command line.
#[derive(Debug, Default, PartialEq)]
struct Parsed {
    positionals: Vec<String>,
    options: Vec<(String, String)>,
    command: Vec<String>,
}

impl Parsed {
    fn option(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn parse(args: &[String], options: &[&str], allow_command: bool) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            if !allow_command {
                return Err("unexpected `--`".into());
            }
            parsed.command = args[index..].to_vec();
            return Ok(parsed);
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            };
            if !options.contains(&name) {
                return Err(format!("unknown option --{name}"));
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    let Some(next) = args.get(index) else {
                        return Err(format!("--{name} needs a value"));
                    };
                    index += 1;
                    next.clone()
                }
            };
            parsed.options.push((name.to_string(), value));
            continue;
        }
        parsed.positionals.push(arg.clone());
    }
    Ok(parsed)
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn require_name(name: Option<&String>, usage: &str) -> String {
    match name {
        Some(name) if valid_name(name) => name.clone(),
        Some(name) => die(&format!(
            "{name} is not a valid NAME: use an environment variable name ([A-Za-z_][A-Za-z0-9_]*)\nusage: {usage}"
        )),
        None => die(&format!("missing NAME\nusage: {usage}")),
    }
}

fn socket_path() -> PathBuf {
    let home = std::env::var_os("COFLUX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".coflux"));
    home.join(SOCKET_DIR).join(SOCKET_FILE)
}

fn connect() -> UnixStream {
    let path = socket_path();
    UnixStream::connect(&path).unwrap_or_else(|error| {
        die(&format!(
            "cannot reach the coflux daemon's secret socket at {} ({error}). coflux secret needs a coflux terminal on a device whose daemon is running and new enough; check `cofluxd status` or update the device",
            path.display()
        ))
    })
}

fn send_request(stream: &mut UnixStream, request: &Value) {
    let mut line = request.to_string().into_bytes();
    line.push(b'\n');
    if let Err(error) = stream.write_all(&line) {
        // The worker may have refused (and closed) before our write landed; its reply, when it
        // got one out, says why far better than a broken pipe does.
        if matches!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            if let Ok(Some(line)) = read_reply(stream) {
                let reply: Value = serde_json::from_slice(&line).unwrap_or(Value::Null);
                if reply.get("ok").and_then(Value::as_bool) == Some(false) {
                    die(&refusal_message(&reply));
                }
            }
        }
        die(&format!("cannot send the request to the coflux daemon: {error}"));
    }
}

/// One reply line, or `None` when the worker closed the connection without answering.
fn read_reply(stream: &UnixStream) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let read = reader.read_until(b'\n', &mut line)?;
    if read == 0 || !line.ends_with(b"\n") {
        wipe(&mut line);
        return Ok(None);
    }
    Ok(Some(line))
}

fn refusal_message(reply: &Value) -> String {
    reply
        .get("error")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("the coflux daemon refused the request")
        .to_string()
}

/* --------------------------------- ask --------------------------------- */

fn ask(args: &[String]) {
    const USAGE: &str = "coflux secret ask NAME --reason \"<why>\" [--timeout <seconds>]";
    let parsed = parse(args, &["reason", "timeout"], false).unwrap_or_else(|error| die(&format!("{error}\nusage: {USAGE}")));
    if parsed.positionals.len() > 1 {
        die(&format!("ask takes one NAME\nusage: {USAGE}"));
    }
    let name = require_name(parsed.positionals.first(), USAGE);
    let reason = parsed.option("reason").unwrap_or_default().trim().to_string();
    if reason.is_empty() {
        die(&format!("--reason is required: tell the user why you need {name}\nusage: {USAGE}"));
    }
    let timeout_secs = match parsed.option("timeout") {
        None => DEFAULT_ASK_TIMEOUT_SECS,
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(secs) if (1..=MAX_ASK_TIMEOUT_SECS).contains(&secs) => secs,
            _ => die(&format!("--timeout must be a whole number of seconds between 1 and {MAX_ASK_TIMEOUT_SECS}")),
        },
    };
    let mut stream = connect();
    let _ = stream.set_read_timeout(Some(Duration::from_secs(timeout_secs) + ASK_REPLY_GRACE));
    send_request(
        &mut stream,
        &json!({ "op": "ask", "name": name, "reason": reason, "timeoutMs": timeout_secs * 1000 }),
    );
    let line = match read_reply(&stream) {
        Ok(Some(line)) => line,
        Ok(None) => {
            // The worker went away mid-wait (hot upgrade, runtime restart): the request is gone.
            println!("cancelled");
            eprintln!("coflux secret: the coflux daemon restarted while waiting, so the request was dropped; ask again");
            std::process::exit(1);
        }
        Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
            println!("cancelled");
            eprintln!("coflux secret: no reply from the coflux daemon in time; ask again");
            std::process::exit(1);
        }
        Err(error) => die(&format!("lost the connection to the coflux daemon: {error}")),
    };
    let reply: Value = serde_json::from_slice(&line).unwrap_or(Value::Null);
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        die(&refusal_message(&reply));
    }
    let outcome = reply.get("outcome").and_then(Value::as_str).unwrap_or("cancelled");
    let detail = reply.get("detail").and_then(Value::as_str).unwrap_or_default();
    match outcome {
        "provided" => {
            println!("provided");
        }
        "declined" => {
            println!("declined");
            std::process::exit(1);
        }
        _ => {
            println!("cancelled");
            match detail {
                "timeout" => eprintln!(
                    "coflux secret: nobody answered within {timeout_secs} s. If no request card appeared on the user's desktop, it may be too old to show secret requests (update Coflux) — tell the user"
                ),
                "closed" => eprintln!("coflux secret: the user closed the request without answering"),
                "session_ended" => eprintln!("coflux secret: this terminal ended while waiting"),
                _ => {}
            }
            std::process::exit(1);
        }
    }
}

/* --------------------------------- exec -------------------------------- */

fn exec(args: &[String]) {
    const USAGE: &str = "coflux secret exec NAME [NAME…] -- <cmd> [args…]";
    let parsed = parse(args, &[], true).unwrap_or_else(|error| die(&format!("{error}\nusage: {USAGE}")));
    if parsed.positionals.is_empty() {
        die(&format!("missing NAME\nusage: {USAGE}"));
    }
    for name in &parsed.positionals {
        if !valid_name(name) {
            die(&format!("{name} is not a valid NAME\nusage: {USAGE}"));
        }
    }
    if parsed.command.is_empty() {
        die(&format!("missing the command after `--`\nusage: {USAGE}"));
    }
    let names = parsed.positionals.clone();
    let mut values = release(&names);

    let mut command = Command::new(&parsed.command[0]);
    command
        .args(&parsed.command[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in names.iter().zip(values.iter()) {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap_or_else(|error| {
        die(&format!("cannot start {}: {error}", parsed.command[0]))
    });
    // Ctrl-C reaches the child through the terminal's process group; stay alive to relay the
    // rest of its (masked) output and its exit status. Set after spawn so the child keeps the
    // default disposition.
    // SAFETY: plain signal(2) calls installing SIG_IGN; no handler code runs.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
    }
    let masks: Vec<Vec<u8>> = values.iter().map(|value| value.as_bytes().to_vec()).collect();
    for value in values.iter_mut() {
        wipe_string(value);
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_masks = masks.clone();
    let out_thread = std::thread::spawn(move || relay(stdout, std::io::stdout(), out_masks));
    let err_masks = masks.clone();
    let err_thread = std::thread::spawn(move || relay(stderr, std::io::stderr(), err_masks));
    let status = child.wait().unwrap_or_else(|error| die(&format!("waiting for the command failed: {error}")));
    let _ = out_thread.join();
    let _ = err_thread.join();
    let mut masks = masks;
    for mask in masks.iter_mut() {
        wipe(mask);
    }
    use std::os::unix::process::ExitStatusExt;
    let code = status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
    std::process::exit(code);
}

/// Fetch the values of `names` from the worker (only the session that asked can).
fn release(names: &[String]) -> Vec<String> {
    let mut stream = connect();
    let _ = stream.set_read_timeout(Some(EXCHANGE_TIMEOUT));
    send_request(&mut stream, &json!({ "op": "release", "names": names }));
    let mut line = match read_reply(&stream) {
        Ok(Some(line)) => line,
        Ok(None) => die("the coflux daemon closed the connection without answering; retry"),
        Err(error) => die(&format!("no reply from the coflux daemon: {error}")),
    };
    let reply: Value = serde_json::from_slice(&line).unwrap_or(Value::Null);
    wipe(&mut line);
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        die(&refusal_message(&reply));
    }
    let Value::Object(mut reply) = reply else {
        die("malformed reply from the coflux daemon");
    };
    let Some(Value::Object(mut values)) = reply.remove("values") else {
        die("malformed reply from the coflux daemon");
    };
    names
        .iter()
        .map(|name| match values.remove(name) {
            Some(Value::String(value)) => value,
            _ => die(&format!("the coflux daemon did not return {name}")),
        })
        .collect()
}

/// Copy `input` to `output` with every value replaced by `***`, flushing as it goes.
fn relay(mut input: impl Read, output: impl Write, values: Vec<Vec<u8>>) {
    let mut output = output;
    let mut masker = Masker::new(values);
    let mut buffer = [0u8; 8192];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let masked = masker.push(&buffer[..n]);
                if !masked.is_empty() && (output.write_all(&masked).is_err() || output.flush().is_err()) {
                    // Our own output is gone; keep draining so the child is not blocked on a pipe.
                    while matches!(input.read(&mut buffer), Ok(n) if n > 0) {}
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let rest = masker.finish();
    let _ = output.write_all(&rest);
    let _ = output.flush();
    buffer.fill(0);
}

/// Streaming redaction: a value split across two chunks is still caught, because a tail that is
/// a proper prefix of some value is held back until the next chunk (or the end) decides it.
/// Output that cannot start a value is released immediately, so prompts are not delayed.
struct Masker {
    /// Longest first, so an overlapping longer value wins.
    values: Vec<Vec<u8>>,
    pending: Vec<u8>,
}

impl Masker {
    fn new(mut values: Vec<Vec<u8>>) -> Self {
        values.retain(|value| !value.is_empty());
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        values.dedup();
        Self {
            values,
            pending: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::with_capacity(self.pending.len());
        let mut index = 0;
        while index < self.pending.len() {
            let rest = &self.pending[index..];
            // Checked before any full match: when a shorter value matches here but a longer one
            // could still complete from this position, redacting the shorter now would leak the
            // longer one's tail once the next chunk arrives.
            if self
                .values
                .iter()
                .any(|value| value.len() > rest.len() && value.starts_with(rest))
            {
                // The tail may be the start of a value: decide once more bytes arrive.
                break;
            }
            if let Some(value) = self.values.iter().find(|value| rest.starts_with(value)) {
                out.extend_from_slice(REDACTED);
                index += value.len();
                continue;
            }
            out.push(self.pending[index]);
            index += 1;
        }
        self.pending.drain(..index);
        out
    }

    fn finish(&mut self) -> Vec<u8> {
        // The held-back tail is not a whole value, but a shorter value may still sit inside it.
        let pending = std::mem::take(&mut self.pending);
        let mut out = Vec::with_capacity(pending.len());
        let mut index = 0;
        while index < pending.len() {
            let rest = &pending[index..];
            if let Some(value) = self.values.iter().find(|value| rest.starts_with(value)) {
                out.extend_from_slice(REDACTED);
                index += value.len();
            } else {
                out.push(pending[index]);
                index += 1;
            }
        }
        out
    }
}

impl Drop for Masker {
    fn drop(&mut self) {
        for value in self.values.iter_mut() {
            wipe(value);
        }
        wipe(&mut self.pending);
    }
}

/* -------------------------------- inject ------------------------------- */

fn inject(args: &[String]) {
    const USAGE: &str = "coflux secret inject NAME --file <path> [--key KEY]";
    let parsed = parse(args, &["file", "key"], false).unwrap_or_else(|error| die(&format!("{error}\nusage: {USAGE}")));
    if parsed.positionals.len() > 1 {
        die(&format!("inject takes one NAME\nusage: {USAGE}"));
    }
    let name = require_name(parsed.positionals.first(), USAGE);
    let Some(file) = parsed.option("file").filter(|file| !file.trim().is_empty()) else {
        die(&format!("--file is required\nusage: {USAGE}"));
    };
    let key = parsed.option("key").unwrap_or(&name).to_string();
    if !valid_name(&key) {
        die(&format!("--key {key} is not a valid variable name"));
    }
    let mut stream = connect();
    let _ = stream.set_read_timeout(Some(EXCHANGE_TIMEOUT));
    send_request(
        &mut stream,
        &json!({ "op": "inject", "name": name, "file": file, "key": key, "cwd": crate::gateway::caller_cwd() }),
    );
    let line = match read_reply(&stream) {
        Ok(Some(line)) => line,
        Ok(None) => die("the coflux daemon closed the connection without answering; retry"),
        Err(error) => die(&format!("no reply from the coflux daemon: {error}")),
    };
    let reply: Value = serde_json::from_slice(&line).unwrap_or(Value::Null);
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        die(&refusal_message(&reply));
    }
    let path = reply.get("path").and_then(Value::as_str).unwrap_or(file);
    let verb = if reply.get("created").and_then(Value::as_bool) == Some(true) {
        "created"
    } else {
        "updated"
    };
    println!("{verb} {path}: wrote {key}");
}

/* -------------------------------- helpers ------------------------------ */

/// Best-effort zeroing of a buffer that held secret bytes.
fn wipe(buffer: &mut Vec<u8>) {
    let capacity = buffer.capacity();
    let pointer = buffer.as_mut_ptr();
    for offset in 0..capacity {
        // SAFETY: within the owned allocation; u8 has no invalid bit patterns.
        unsafe { std::ptr::write_volatile(pointer.add(offset), 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    buffer.clear();
}

fn wipe_string(value: &mut String) {
    let mut bytes = std::mem::take(value).into_bytes();
    wipe(&mut bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(values: &[&str], chunks: &[&str]) -> String {
        let mut masker = Masker::new(values.iter().map(|value| value.as_bytes().to_vec()).collect());
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(masker.push(chunk.as_bytes()));
        }
        out.extend(masker.finish());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn a_value_split_across_chunks_is_still_masked() {
        assert_eq!(masked(&["s3cr3t-token"], &["key=s3cr", "3t-tok", "en done\n"]), "key=*** done\n");
        assert_eq!(masked(&["abc"], &["a", "b", "c"]), "***");
        assert_eq!(masked(&["abc"], &["xa", "bcx"]), "x***x");
    }

    #[test]
    fn a_held_back_prefix_that_never_completes_is_released() {
        assert_eq!(masked(&["abcdef"], &["xyz abc"]), "xyz abc");
        assert_eq!(masked(&["abcdef"], &["abc", "xyz"]), "abcxyz");
    }

    #[test]
    fn output_that_cannot_start_a_value_is_not_held_back() {
        let mut masker = Masker::new(vec![b"secret".to_vec()]);
        assert_eq!(masker.push(b"prompt> "), b"prompt> ".to_vec());
        assert_eq!(masker.push(b"se"), Vec::<u8>::new());
        assert_eq!(masker.push(b"cret!"), b"***!".to_vec());
    }

    #[test]
    fn a_shorter_value_waits_while_a_longer_one_could_still_complete() {
        assert_eq!(masked(&["abcd", "ab"], &["xab", "cdy"]), "x***y");
        assert_eq!(masked(&["abcd", "ab"], &["xab", "zz"]), "x***zz");
    }

    #[test]
    fn longer_and_shorter_values_both_masked() {
        assert_eq!(masked(&["abcd", "b"], &["xab"]), "xa***");
        assert_eq!(masked(&["abcd", "b"], &["abcd b"]), "*** ***");
        assert_eq!(masked(&["one", "two"], &["one two three"]), "*** *** three");
    }

    #[test]
    fn exec_arguments_split_at_double_dash() {
        let args: Vec<String> = ["A", "B", "--", "sh", "-c", "echo --x"].iter().map(|s| s.to_string()).collect();
        let parsed = parse(&args, &[], true).unwrap();
        assert_eq!(parsed.positionals, vec!["A", "B"]);
        assert_eq!(parsed.command, vec!["sh", "-c", "echo --x"]);
    }

    #[test]
    fn options_accept_both_spellings_and_reject_unknown_ones() {
        let args: Vec<String> = ["TOKEN", "--reason", "deploy", "--timeout=30"].iter().map(|s| s.to_string()).collect();
        let parsed = parse(&args, &["reason", "timeout"], false).unwrap();
        assert_eq!(parsed.option("reason"), Some("deploy"));
        assert_eq!(parsed.option("timeout"), Some("30"));
        assert!(parse(&["--bogus".to_string()], &["reason"], false).is_err());
        assert!(parse(&["--".to_string()], &["reason"], false).is_err());
        assert!(parse(&["--reason".to_string()], &["reason"], false).is_err());
    }

    #[test]
    fn names_are_environment_variable_names() {
        assert!(valid_name("OPENAI_API_KEY"));
        assert!(!valid_name("1X"));
        assert!(!valid_name("A-B"));
    }
}
