//! `coflux secret inject`: the worker writes a `KEY=value` entry into a dotenv file itself, so the
//! value never leaves this process on that path.
//!
//! The target must resolve inside the caller's effective workspace. Resolution canonicalizes the
//! file when it exists (so a symlink pointing outside the workspace is refused) and the parent
//! directory when it does not. A newly created file is owner-only (0600); an existing file keeps
//! its permissions. The file is replaced atomically through a temporary sibling.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use rand_core::{OsRng, RngCore};

use super::SecretBytes;

/// Upper bound on an existing dotenv file the worker is willing to rewrite.
const MAX_DOTENV_BYTES: u64 = 1024 * 1024;

pub struct Injected {
    /// Canonical path of the written file.
    pub path: String,
    /// The file did not exist before.
    pub created: bool,
    /// An existing entry for the key was replaced (false = appended).
    pub replaced: bool,
}

/// Resolve `file` (relative to `cwd` unless absolute) and require it to lie inside
/// `workspace_root`. Returns the canonical target path and whether it already exists.
pub fn resolve_target(workspace_root: &str, cwd: &str, file: &str) -> Result<(PathBuf, bool), String> {
    if file.trim().is_empty() {
        return Err("--file is required".into());
    }
    let root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("the workspace directory is not accessible: {error}"))?;
    let requested = Path::new(file);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        if cwd.is_empty() {
            return Err("the caller's working directory is unknown; pass an absolute --file".into());
        }
        Path::new(cwd).join(requested)
    };
    let outside = || {
        format!(
            "{} is outside this terminal's workspace ({}); secret inject only writes inside it",
            joined.display(),
            root.display()
        )
    };
    match fs::symlink_metadata(&joined) {
        Ok(_) => {
            // Follows symlinks: a link that escapes the workspace resolves outside the root.
            let target = fs::canonicalize(&joined).map_err(|error| format!("cannot resolve {}: {error}", joined.display()))?;
            if !target.starts_with(&root) {
                return Err(outside());
            }
            let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!("{} is not a regular file", target.display()));
            }
            Ok((target, true))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let name = match joined.components().next_back() {
                Some(Component::Normal(name)) => name.to_owned(),
                _ => return Err(format!("{} does not name a file", joined.display())),
            };
            let parent = joined.parent().ok_or_else(|| format!("{} has no parent directory", joined.display()))?;
            let parent = fs::canonicalize(parent).map_err(|error| {
                format!("the directory of {} is not accessible: {error}", joined.display())
            })?;
            if !parent.starts_with(&root) {
                return Err(outside());
            }
            Ok((parent.join(name), false))
        }
        Err(error) => Err(format!("cannot inspect {}: {error}", joined.display())),
    }
}

/// Insert or update `key=value` in the dotenv file at `target` (already resolved and checked by
/// [`resolve_target`]).
pub fn write_entry(target: &Path, existed: bool, key: &str, value: &SecretBytes) -> Result<Injected, String> {
    let value = std::str::from_utf8(value.as_bytes()).map_err(|_| "the value is not UTF-8 text".to_string())?;
    let (existing, mode) = if existed {
        let metadata = fs::metadata(target).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_DOTENV_BYTES {
            return Err(format!("{} is too large to be a dotenv file", target.display()));
        }
        let raw = fs::read(target).map_err(|error| format!("cannot read {}: {error}", target.display()))?;
        let raw = SecretBytes::new(raw);
        if std::str::from_utf8(raw.as_bytes()).is_err() {
            return Err(format!("{} is not UTF-8 text", target.display()));
        }
        (raw, metadata.permissions().mode() & 0o7777)
    } else {
        (SecretBytes::new(Vec::new()), 0o600)
    };
    let existing_text = std::str::from_utf8(existing.as_bytes()).unwrap_or_default();
    let entry = format_entry(key, value);
    let (content, replaced) = upsert(existing_text, key, entry.as_bytes());
    let content = SecretBytes::new(content);
    drop(entry);

    let directory = target.parent().ok_or("the target has no parent directory")?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let temporary = directory.join(format!(".{file_name}.coflux-{}", hex::encode(random)));
    let write = || -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if mode != 0o600 {
            fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
        }
        fs::rename(&temporary, target)
    };
    if let Err(error) = write() {
        let _ = fs::remove_file(&temporary);
        return Err(format!("cannot write {}: {error}", target.display()));
    }
    Ok(Injected {
        path: target.to_string_lossy().into_owned(),
        created: !existed,
        replaced,
    })
}

/// `KEY=value`, quoted only when needed. Bare values are limited to characters every dotenv
/// dialect reads literally; values without `'` or line breaks are single-quoted (literal in
/// dotenv, docker compose and shells); anything else is double-quoted with `\`, `"`, `$` and
/// line breaks escaped.
fn format_entry(key: &str, value: &str) -> SecretBytes {
    let bare = !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-./:@+,%~^".contains(&byte));
    let mut out = SecretBytes::with_capacity(key.len() + 4 + value.len() * 2);
    out.extend_from_slice(key.as_bytes());
    out.extend_from_slice(b"=");
    if bare {
        out.extend_from_slice(value.as_bytes());
    } else if !value.contains('\'') && !value.contains('\n') && !value.contains('\r') {
        out.extend_from_slice(b"'");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"'");
    } else {
        out.extend_from_slice(b"\"");
        for byte in value.bytes() {
            match byte {
                b'\\' => out.extend_from_slice(b"\\\\"),
                b'"' => out.extend_from_slice(b"\\\""),
                b'$' => out.extend_from_slice(b"\\$"),
                b'\n' => out.extend_from_slice(b"\\n"),
                b'\r' => out.extend_from_slice(b"\\r"),
                _ => out.extend_from_slice(&[byte]),
            }
        }
        out.extend_from_slice(b"\"");
    }
    out
}

/// Whether `line` assigns `key` (`KEY=…`, `export KEY=…`, spaces around `=` allowed).
fn assigns(line: &str, key: &str) -> bool {
    let trimmed = line.trim_start();
    let trimmed = trimmed
        .strip_prefix("export ")
        .map(str::trim_start)
        .unwrap_or(trimmed);
    trimmed
        .strip_prefix(key)
        .is_some_and(|rest| rest.trim_start().starts_with('='))
}

/// Replace the first assignment of `key` with `entry` and drop later duplicates, or append.
fn upsert(existing: &str, key: &str, entry: &[u8]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(existing.len() + entry.len() + 2);
    let mut replaced = false;
    for line in existing.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        if assigns(body, key) {
            if !replaced {
                out.extend_from_slice(entry);
                out.push(b'\n');
                replaced = true;
            }
            continue;
        }
        out.extend_from_slice(line.as_bytes());
    }
    if !replaced {
        if !out.is_empty() && !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        out.extend_from_slice(entry);
        out.push(b'\n');
    }
    (out, replaced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let mut random = [0u8; 6];
        OsRng.fill_bytes(&mut random);
        let dir = std::env::temp_dir().join(format!("coflux-dotenv-{label}-{}", hex::encode(random)));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn entries_are_quoted_only_when_needed() {
        assert_eq!(format_entry("K", "abc-123_x.y").as_bytes(), b"K=abc-123_x.y");
        assert_eq!(format_entry("K", "a b#c").as_bytes(), b"K='a b#c'");
        assert_eq!(format_entry("K", "it's $x\n").as_bytes(), b"K=\"it's \\$x\\n\"");
    }

    #[test]
    fn upsert_replaces_the_first_assignment_and_drops_duplicates() {
        let (out, replaced) = upsert("A=1\nexport KEY = old\nB=2\nKEY=dup\n", "KEY", b"KEY=new");
        assert!(replaced);
        assert_eq!(String::from_utf8(out).unwrap(), "A=1\nKEY=new\nB=2\n");
        let (out, replaced) = upsert("A=1", "KEY", b"KEY=new");
        assert!(!replaced);
        assert_eq!(String::from_utf8(out).unwrap(), "A=1\nKEY=new\n");
        let (out, _) = upsert("KEYS=1\n", "KEY", b"KEY=new");
        assert_eq!(String::from_utf8(out).unwrap(), "KEYS=1\nKEY=new\n");
    }

    #[test]
    fn targets_outside_the_workspace_are_refused() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        fs::write(outside.join("real.env"), "X=1\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        assert!(resolve_target(&root_str, &root_str, ".env").is_ok());
        assert!(resolve_target(&root_str, &root_str, "../escape.env").is_err());
        assert!(resolve_target(&root_str, &root_str, &outside.join("new.env").to_string_lossy()).is_err());

        std::os::unix::fs::symlink(outside.join("real.env"), root.join("link.env")).unwrap();
        let error = resolve_target(&root_str, &root_str, "link.env").unwrap_err();
        assert!(error.contains("outside"), "{error}");

        fs::create_dir(root.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("sub/escape")).unwrap();
        assert!(resolve_target(&root_str, &root_str, "sub/escape/new.env").is_err());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn new_files_are_owner_only_and_existing_ones_keep_their_mode() {
        let root = temp_dir("write");
        let root_str = root.to_string_lossy().into_owned();
        let value = SecretBytes::new(b"s3cr3t".to_vec());

        let (target, existed) = resolve_target(&root_str, &root_str, ".env").unwrap();
        let written = write_entry(&target, existed, "TOKEN", &value).unwrap();
        assert!(written.created);
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&target).unwrap(), "TOKEN=s3cr3t\n");

        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let (target, existed) = resolve_target(&root_str, &root_str, ".env").unwrap();
        let written = write_entry(&target, existed, "TOKEN", &SecretBytes::new(b"next".to_vec())).unwrap();
        assert!(!written.created);
        assert!(written.replaced);
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(fs::read_to_string(&target).unwrap(), "TOKEN=next\n");

        let _ = fs::remove_dir_all(root);
    }
}
