//! Entity handles: the paste-recognisable short form of a coflux entity id.
//!
//! Grammar: `coflux:<kind>:<hex>` with `kind` one of `device` / `project` / `workspace` /
//! `terminal` and `hex` 4–32 hexadecimal characters — the leading characters of the entity's
//! UUID. Parsing is case-insensitive and normalises to lowercase; generation always emits
//! lowercase and always takes exactly the first 8 characters (the first dash-delimited group of a
//! UUID), which is the collision budget the ambiguity error is the visible cost of.
//!
//! Handles are a boundary concept: they are resolved to real ids at the entry point and nothing
//! below it ever sees one. UUIDs stay canonical everywhere else. The rule is a pure concatenation,
//! so every client composes it locally instead of carrying a `ref` on the wire — see the Rust CLI's
//! `crates/cli/src/handle.rs`, which is the same grammar for the other side of the same protocol.

/// The four entity kinds a handle can name. PTY sessions deliberately have none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HandleKind {
    Device,
    Project,
    Workspace,
    Terminal,
}

impl HandleKind {
    /// The token that appears in the handle itself.
    pub fn token(self) -> &'static str {
        match self {
            HandleKind::Device => "device",
            HandleKind::Project => "project",
            HandleKind::Workspace => "workspace",
            HandleKind::Terminal => "terminal",
        }
    }

    /// 给用户读的名字：错误里要同时说清「给的是什么」与「要的是什么」。
    pub fn label(self) -> &'static str {
        match self {
            HandleKind::Device => "设备",
            HandleKind::Project => "项目",
            HandleKind::Workspace => "工作区",
            HandleKind::Terminal => "终端",
        }
    }

    fn from_token(token: &str) -> Option<Self> {
        match token {
            "device" => Some(HandleKind::Device),
            "project" => Some(HandleKind::Project),
            "workspace" => Some(HandleKind::Workspace),
            "terminal" => Some(HandleKind::Terminal),
            _ => None,
        }
    }
}

/// A parsed handle: the kind token plus the normalised lowercase id prefix it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Handle {
    pub kind: HandleKind,
    /// Lowercase hex, 4–32 characters. Matching an id means matching this as a prefix.
    pub prefix: String,
}

/// The handle of `id`. Empty in, empty out: a missing coordinate must not become `coflux:x:`.
pub(crate) fn of(kind: HandleKind, id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    let short: String = id.chars().take(8).collect::<String>().to_ascii_lowercase();
    format!("coflux:{}:{short}", kind.token())
}

/// Parse a handle, or `None` when `raw` is anything else (a bare UUID included — the caller then
/// treats it as the id it looks like). Case-insensitive; the result is normalised to lowercase.
pub(crate) fn parse(raw: &str) -> Option<Handle> {
    let lower = raw.to_ascii_lowercase();
    let mut parts = lower.split(':');
    if parts.next()? != "coflux" {
        return None;
    }
    let kind = HandleKind::from_token(parts.next()?)?;
    let prefix = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !(4..=32).contains(&prefix.len()) || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(Handle {
        kind,
        prefix: prefix.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_is_always_lowercase_and_eight_characters() {
        assert_eq!(
            of(HandleKind::Terminal, "9E21C4D0-1111-2222-3333-444455556666"),
            "coflux:terminal:9e21c4d0"
        );
        assert_eq!(
            of(HandleKind::Workspace, "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff"),
            "coflux:workspace:3f2a1b7c"
        );
        assert_eq!(of(HandleKind::Device, ""), "", "缺坐标时不能造出半截标识");
    }

    #[test]
    fn parsing_is_case_insensitive_and_normalises_to_lowercase() {
        let parsed = parse("COFLUX:Workspace:3F2A1B7C").expect("大小写不敏感");
        assert_eq!(parsed.kind, HandleKind::Workspace);
        assert_eq!(parsed.prefix, "3f2a1b7c");
        assert_eq!(parse("coflux:terminal:9e21").unwrap().prefix, "9e21");
    }

    #[test]
    fn a_bare_uuid_and_a_malformed_handle_are_not_handles() {
        assert!(parse("9e21c4d0-1111-2222-3333-444455556666").is_none());
        assert!(parse("coflux:session:9e21c4d0").is_none(), "会话没有标识");
        assert!(parse("cfx:terminal:9e21c4d0").is_none());
        assert!(parse("coflux:terminal:9e2").is_none(), "少于 4 位不算标识");
        assert!(parse("coflux:terminal:zzzzzzzz").is_none(), "必须是十六进制");
        assert!(parse("coflux:terminal:9e21c4d0:extra").is_none());
        assert!(parse("coflux:terminal").is_none());
        assert!(parse("").is_none());
        let too_long = "0".repeat(33);
        assert!(parse(&format!("coflux:terminal:{too_long}")).is_none());
    }

    #[test]
    fn every_generated_handle_parses_back_to_its_kind() {
        for kind in [
            HandleKind::Device,
            HandleKind::Project,
            HandleKind::Workspace,
            HandleKind::Terminal,
        ] {
            let text = of(kind, "b6767697-60b2-4700-a304-1404bf03c675");
            let parsed = parse(&text).expect("生成的标识必须能解析回去");
            assert_eq!(parsed.kind, kind);
            assert_eq!(parsed.prefix, "b6767697");
        }
    }
}
