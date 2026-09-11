//! 与 node 版 `parseArgs({ allowPositionals: true, options })` 等价的最小解析（plan 112）。
//!
//! 选项表照抄 `packages/cli/cofluxd.mjs` 的 parseArgs 配置——管理类命令的选项（--server /
//! --bin-dir …）也认，这样「管理类命令被明确拒绝」这条路径不会先被「未知选项」截胡。
//! 语义对齐 node 严格模式：`--opt=value` / `--opt value`（下一个参数无论是否以 `-` 开头都算值）、
//! 布尔选项不带值、`-f` / `-h` 短名可成组、`--` 之后全是位置参数、未知选项即报错。

use std::collections::{HashMap, HashSet};

const STRING_OPTIONS: &[&str] = &[
    "server", "name", "shell", "title", "cmd", "lines", "timeout", "text", "version", "bin-dir",
    // executor（plan 116）：入参只有 prompt 与读写模式两样，不给 model 覆盖
    "prompt",
];
const BOOL_OPTIONS: &[&str] = &["enter", "no-start", "purge", "follow", "help", "write"];
const SHORT_OPTIONS: &[(char, &str)] = &[('f', "follow"), ('h', "help")];

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
            // 短选项组：`-fh` = `-f -h`；本 CLI 的短名全是布尔，没有带值的短选项。
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
    fn short_flags_and_groups() {
        let parsed = parse(argv(&["logs", "-f"])).unwrap();
        assert!(parsed.flag("follow"));
        let parsed = parse(argv(&["-fh"])).unwrap();
        assert!(parsed.flag("follow") && parsed.flag("help"));
        assert!(parse(argv(&["-x"])).is_err());
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

    #[test]
    fn repeated_string_option_last_wins() {
        let parsed = parse(argv(&["--lines", "10", "--lines", "20"])).unwrap();
        assert_eq!(parsed.string("lines"), Some("20"));
    }
}
