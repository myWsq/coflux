//! Entity handles: the paste-recognisable short form of a coflux entity id.
//!
//! Grammar: `coflux:<kind>:<hex>` with `kind` one of `device` / `project` / `workspace` /
//! `terminal` and `hex` 4–32 hexadecimal characters — the leading characters of the entity's
//! UUID. Parsing is case-insensitive and normalises to lowercase; generation always emits
//! lowercase and always takes exactly the first 8 characters (the first dash-delimited group of a
//! UUID). A handle is accepted anywhere the id is, and every entity that comes back carries one.
//!
//! The rule is a pure concatenation, so it is composed locally rather than carried on the wire.
//! It is mirrored verbatim by `crates/worker/src/handle.rs` (the daemon side of the same local
//! protocol) and by `parseHandle` / `entityHandle` in `packages/cli/account-client.mjs` (the node
//! CLI, whose output is contractually word-for-word identical to this one's).

/// The four entity kinds a handle can name. PTY sessions deliberately have none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandleKind {
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
pub struct Handle {
    pub kind: HandleKind,
    /// Lowercase hex, 4–32 characters. Matching an id means matching this as a prefix.
    pub prefix: String,
}

/// The handle of `id`. Empty in, empty out: a missing coordinate must not become `coflux:x:`.
pub fn of(kind: HandleKind, id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    let short: String = id.chars().take(8).collect::<String>().to_ascii_lowercase();
    format!("coflux:{}:{short}", kind.token())
}

/// Parse a handle, or `None` when `raw` is anything else (a bare UUID included — the caller then
/// treats it as the id it looks like). Case-insensitive; the result is normalised to lowercase.
pub fn parse(raw: &str) -> Option<Handle> {
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

/// Does a `--device` / `--workspace` filter value select this id? A handle matches by kind plus
/// prefix, anything else by exact equality. This is a **comparison**, not a resolution: no lookup
/// happens, only the same grammar — which is exactly why a handle must not be allowed to fall
/// through to the string compare and quietly match nothing.
pub fn matches(target: &str, id: Option<&str>, expected: HandleKind) -> bool {
    match parse(target) {
        Some(parsed) => {
            parsed.kind == expected
                && id.is_some_and(|id| id.to_ascii_lowercase().starts_with(&parsed.prefix))
        }
        None => id == Some(target),
    }
}

/// A filter flag was handed a handle of the wrong kind: say so instead of printing an empty list.
/// Anything that is not a handle at all passes through untouched — it is an id as far as we know.
pub fn check_filter(flag: &str, expected: HandleKind, target: &str) -> Result<(), String> {
    match parse(target) {
        Some(parsed) if parsed.kind != expected => Err(format!(
            "--{flag} 需要{}标识或{} ID，给的是{}标识 {target}",
            expected.label(),
            expected.label(),
            parsed.kind.label()
        )),
        _ => Ok(()),
    }
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
            of(HandleKind::Device, "b6767697-60b2-4700-a304-1404bf03c675"),
            "coflux:device:b6767697"
        );
        assert_eq!(of(HandleKind::Project, ""), "", "缺坐标时不能造出半截标识");
    }

    #[test]
    fn parsing_is_case_insensitive_and_rejects_everything_else() {
        let parsed = parse("COFLUX:Workspace:3F2A1B7C").expect("大小写不敏感");
        assert_eq!(parsed.kind, HandleKind::Workspace);
        assert_eq!(parsed.prefix, "3f2a1b7c");
        assert!(parse("3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff").is_none());
        assert!(parse("coflux:session:3f2a1b7c").is_none(), "会话没有标识");
        assert!(parse("coflux:workspace:3f2").is_none(), "少于 4 位不算标识");
        assert!(parse("coflux:workspace:xyz12345").is_none(), "必须是十六进制");
        assert!(parse("coflux:workspace:3f2a1b7c:more").is_none());
    }

    #[test]
    fn filters_accept_a_handle_a_raw_id_and_nothing_of_another_kind() {
        let device = "b6767697-60b2-4700-a304-1404bf03c675";
        assert!(matches(device, Some(device), HandleKind::Device), "原样 ID 仍然精确匹配");
        assert!(matches("coflux:device:b6767697", Some(device), HandleKind::Device));
        assert!(matches("COFLUX:DEVICE:B6767697", Some(device), HandleKind::Device));
        // 别的设备不会被前缀误伤
        assert!(!matches("coflux:device:b6767697", Some("b6767698-0000-0000-0000-000000000000"), HandleKind::Device));
        // 类型不对就是不匹配（同时 check_filter 会把它变成一句可读的错）
        assert!(!matches("coflux:workspace:b6767697", Some(device), HandleKind::Device));
        // 字段缺失（快照里没有 daemonId）不能算命中
        assert!(!matches("coflux:device:b6767697", None, HandleKind::Device));
        assert!(!matches(device, None, HandleKind::Device));
    }

    #[test]
    fn a_wrong_kind_filter_names_both_kinds() {
        assert!(check_filter("device", HandleKind::Device, "coflux:device:b6767697").is_ok());
        assert!(check_filter("device", HandleKind::Device, "b6767697-60b2-4700-a304-1404bf03c675").is_ok());
        let error = check_filter("device", HandleKind::Device, "coflux:workspace:3f2a1b7c")
            .expect_err("类型不符必须报错，不能打印空列表");
        assert_eq!(
            error,
            "--device 需要设备标识或设备 ID，给的是工作区标识 coflux:workspace:3f2a1b7c"
        );
        let error = check_filter("workspace", HandleKind::Workspace, "coflux:terminal:9e21c4d0")
            .expect_err("类型不符必须报错");
        assert!(error.contains("工作区标识"), "{error}");
        assert!(error.contains("终端标识"), "{error}");
    }
}
