//! 与 node 版 `parseArgs({ allowPositionals: true, options })` 等价的最小解析（plan 112）。
//!
//! 选项表与 `packages/cli/coflux.mjs` 一致，只接受业务操作参数。
//! 语义对齐 node 严格模式：`--opt=value` / `--opt value`（下一个参数无论是否以 `-` 开头都算值）、
//! 布尔选项不带值、`-h` 帮助短名、`--` 之后全是位置参数、未知选项即报错。

use std::collections::{HashMap, HashSet};

const STRING_OPTIONS: &[&str] = &[
    "username", "workspace", "device", "project", "branch", "server", "name", "title", "cmd", "lines", "timeout", "text", "seq",
    // `device exec`: the working directory on the remote device (absolute, or a `~` prefix).
    "cwd",
    // executor: the only free-form input is the prompt; the model is configured once in Coflux.app.
    "prompt",
];
const BOOL_OPTIONS: &[&str] = &["password-stdin", "remote", "existing-branch", "json", "enter", "help",
    // executor: read-only by default; --write is the only mode switch.
    "write"];
const SHORT_OPTIONS: &[(char, &str)] = &[('h', "help")];

#[derive(Debug, Default, PartialEq)]
pub struct ParsedArgs {
    pub positionals: Vec<String>,
    strings: HashMap<String, String>,
    flags: HashSet<String>,
}

impl ParsedArgs {
    /// 字符串选项的值（重复出现取最后一次）。
    pub fn string(&self, name: &str) -> Option<&str> {
        self.strings.get(name).map(String::as_str)
    }

    /// 布尔选项是否出现。
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }

    /// 第 index 个位置参数（0 = 子命令名）。
    pub fn positional(&self, index: usize) -> Option<&str> {
        self.positionals.get(index).map(String::as_str)
    }
}

/// 解析 argv（不含程序名）。出错文案对齐 node 的 ERR_PARSE_ARGS_* 语义（措辞中文）。
pub fn parse<I>(args: I) -> Result<ParsedArgs, String>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    let mut parsed = ParsedArgs::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            parsed.positionals.extend(args[index..].iter().cloned());
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            };
            if STRING_OPTIONS.contains(&name) {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        let Some(next) = args.get(index) else {
                            return Err(format!("选项 '--{name} <value>' 缺参数"));
                        };
                        index += 1;
                        next.clone()
                    }
                };
                parsed.strings.insert(name.to_string(), value);
            } else if BOOL_OPTIONS.contains(&name) {
                if inline.is_some() {
                    return Err(format!("选项 '--{name}' 不接受参数"));
                }
                parsed.flags.insert(name.to_string());
            } else {
                return Err(format!("未知选项 '--{name}'"));
            }
            continue;
        }
        if arg.len() > 1 && arg.starts_with('-') {
            // 短选项为布尔参数。
            for short in arg[1..].chars() {
                let Some((_, name)) = SHORT_OPTIONS.iter().find(|(c, _)| *c == short) else {
                    return Err(format!("未知选项 '-{short}'"));
                };
                parsed.flags.insert((*name).to_string());
            }
            continue;
        }
        parsed.positionals.push(arg.clone());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn positionals_and_string_options() {
        let parsed = parse(argv(&[
            "terminal", "new", "--title", "坐标", "--cmd=pnpm test",
        ]))
        .unwrap();
        assert_eq!(parsed.positionals, vec!["terminal", "new"]);
        assert_eq!(parsed.string("title"), Some("坐标"));
        assert_eq!(parsed.string("cmd"), Some("pnpm test"));
        assert_eq!(parsed.string("text"), None);
        assert!(!parsed.flag("enter"));
    }

    #[test]
    fn string_option_value_may_start_with_dash_like_node() {
        let parsed = parse(argv(&["terminal", "send", "t1", "--text", "-n", "--enter"])).unwrap();
        assert_eq!(parsed.string("text"), Some("-n"));
        assert!(parsed.flag("enter"));
        assert_eq!(parsed.positionals, vec!["terminal", "send", "t1"]);
    }

    #[test]
    fn empty_inline_value_is_kept() {
        let parsed = parse(argv(&["terminal", "new", "--cmd="])).unwrap();
        assert_eq!(parsed.string("cmd"), Some(""));
    }

    #[test]
    fn short_help_flag() {
        let parsed = parse(argv(&["-h"])).unwrap();
        assert!(parsed.flag("help"));
        assert!(parse(argv(&["-f"])).is_err());
        assert!(parse(argv(&["--bin-dir", "/tmp"])).is_err());
    }

    #[test]
    fn double_dash_ends_options() {
        let parsed = parse(argv(&["notify", "--", "--not-an-option", "x"])).unwrap();
        assert_eq!(parsed.positionals, vec!["notify", "--not-an-option", "x"]);
    }

    #[test]
    fn errors_match_node_strict_mode() {
        assert_eq!(parse(argv(&["--bogus"])).unwrap_err(), "未知选项 '--bogus'");
        assert_eq!(
            parse(argv(&["terminal", "new", "--cmd"])).unwrap_err(),
            "选项 '--cmd <value>' 缺参数"
        );
        assert_eq!(parse(argv(&["--enter=1"])).unwrap_err(), "选项 '--enter' 不接受参数");
    }

    /// `device exec` 的三个选项都必须在选项表里：漏一个不是「该参数被忽略」，而是整条命令
    /// 以「未知选项」失败。
    #[test]
    fn device_exec_options_are_in_the_table() {
        let parsed = parse(argv(&[
            "device",
            "exec",
            "d1",
            "--cmd=cd /opt && ls | wc -l",
            "--cwd=~/logs",
            "--timeout",
            "300",
        ]))
        .unwrap();
        assert_eq!(parsed.positionals, vec!["device", "exec", "d1"]);
        assert_eq!(parsed.string("cmd"), Some("cd /opt && ls | wc -l"));
        assert_eq!(parsed.string("cwd"), Some("~/logs"));
        assert_eq!(parsed.string("timeout"), Some("300"));
    }

    #[test]
    fn repeated_string_option_last_wins() {
        let parsed = parse(argv(&["--lines", "10", "--lines", "20"])).unwrap();
        assert_eq!(parsed.string("lines"), Some("20"));
    }
}
