//! Shell entry points for device-managed Claude Code and Codex integration.
//!
//! zsh/bash load a wrapper after user startup files; fish uses vendor configuration.
//! Wrappers resolve `<COFLUX_HOME>/bin/coflux` on each invocation so existing shells
//! can launch updated integration. The native CLI pins immutable hooks and skill
//! files for each agent. User aliases/functions keep precedence.
//!
//! Installations without the native CLI retain the legacy Claude plugin-directory
//! fallback. Unknown shells can call `coflux agent run` explicitly. Templates are
//! embedded in supervisor and staged under `<COFLUX_HOME>/shell-integration`.

use std::path::{Path, PathBuf};

use crate::sessions::prepend_path_segment;

const CLAUDE_SH: &str = include_str!("shell/claude.sh");
const ZSHENV: &str = include_str!("shell/zshenv.zsh");
const ZPROFILE: &str = include_str!("shell/zprofile.zsh");
const ZSHRC: &str = include_str!("shell/zshrc.zsh");
const ZLOGIN: &str = include_str!("shell/zlogin.zsh");
const INIT_BASH: &str = include_str!("shell/init.bash");
const COFLUX_FISH: &str = include_str!("shell/coflux.fish");

/// rc 模板里代表「本集成目录」的占位符，落盘时换成**单引号包好**的绝对路径（COFLUX_HOME 可能带空格）。
const DIR_PLACEHOLDER: &str = "@COFLUX_SHELL_INTEGRATION_DIR@";

/// XDG 规范规定的 `XDG_DATA_DIRS` 默认值。变量原本没设时必须把默认值一并写回去，
/// 否则只放我们这一段等于把系统的 vendor conf 全丢了。
const XDG_DATA_DIRS_DEFAULT: &str = "/usr/local/share:/usr/share";

/// 起会话 shell 时要额外加的命令行参数与**覆盖写**的环境变量。
#[derive(Debug, PartialEq, Eq)]
pub struct Injection {
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Zsh,
    Bash,
    Fish,
}

/// `<COFLUX_HOME>/shell-integration`
pub fn dir(home: &str) -> PathBuf {
    Path::new(home).join("shell-integration")
}

/// 把 rc 全套写进 `<COFLUX_HOME>/shell-integration/`（幂等覆盖）。照 `fda::write_status` 的纪律：
/// 辅助能力，不 panic、失败静默——写不出来时 `plan()` 找不到文件，会话就退回今天的行为。
pub fn write_files(home: &str) {
    let root = dir(home);
    let quoted = sh_quote(&root.to_string_lossy());
    let render = |template: &str| template.replace(DIR_PLACEHOLDER, &quoted);
    if std::fs::create_dir_all(root.join("zsh")).is_err()
        || std::fs::create_dir_all(root.join("bash")).is_err()
        || std::fs::create_dir_all(root.join("fish-data/fish/vendor_conf.d")).is_err()
    {
        return;
    }
    let _ = std::fs::write(root.join("claude.sh"), render(CLAUDE_SH));
    let _ = std::fs::write(root.join("zsh/.zshenv"), render(ZSHENV));
    let _ = std::fs::write(root.join("zsh/.zprofile"), render(ZPROFILE));
    let _ = std::fs::write(root.join("zsh/.zshrc"), render(ZSHRC));
    let _ = std::fs::write(root.join("zsh/.zlogin"), render(ZLOGIN));
    let _ = std::fs::write(root.join("bash/init.bash"), render(INIT_BASH));
    let _ = std::fs::write(
        root.join("fish-data/fish/vendor_conf.d/coflux.fish"),
        render(COFLUX_FISH),
    );
}

/// 给 `shell` 算注入方案；`lookup` 读的是 supervisor 自己的环境（会话继承的那份）。
/// 返回 `None` = 不注入：认不出的 shell，或者 rc 文件不在（没写成/被删/旧 home）——
/// 后者尤其要挡住：`ZDOTDIR` 指向一个没有 rc 的目录会让 zsh 连用户自己的启动文件都不读。
pub fn plan(shell: &str, home: &str, lookup: impl Fn(&str) -> Option<String>) -> Option<Injection> {
    let root = dir(home);
    let claude = root.join("claude.sh");
    match shell_kind(shell)? {
        Kind::Zsh => {
            let zsh = root.join("zsh");
            let complete = [".zshenv", ".zprofile", ".zshrc", ".zlogin"]
                .iter()
                .all(|name| zsh.join(name).is_file());
            if !complete || !claude.is_file() {
                return None;
            }
            Some(Injection {
                args: vec![],
                envs: vec![
                    // 用户原本设过的 ZDOTDIR 交给 rc 去转发；没设过就是空串（rc 里退回 $HOME）。
                    (
                        "COFLUX_USER_ZDOTDIR".to_string(),
                        lookup("ZDOTDIR").unwrap_or_default(),
                    ),
                    ("ZDOTDIR".to_string(), path_string(&zsh)),
                ],
            })
        }
        Kind::Bash => {
            let init = root.join("bash/init.bash");
            if !init.is_file() || !claude.is_file() {
                return None;
            }
            Some(Injection {
                // `--init-file` 顶替的就是交互式非登录 bash 的 ~/.bashrc；init.bash 里已把它原样 source 回来。
                args: vec!["--init-file".to_string(), path_string(&init)],
                envs: vec![],
            })
        }
        Kind::Fish => {
            let conf = root.join("fish-data/fish/vendor_conf.d/coflux.fish");
            if !conf.is_file() {
                return None;
            }
            let current = lookup("XDG_DATA_DIRS")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| XDG_DATA_DIRS_DEFAULT.to_string());
            Some(Injection {
                args: vec![],
                envs: vec![(
                    "XDG_DATA_DIRS".to_string(),
                    prepend_path_segment(&path_string(&root.join("fish-data")), Some(&current)),
                )],
            })
        }
    }
}

/// 只认 basename，且只认这三种；`-zsh` 这类登录 shell 惯例的前导 `-` 先剥掉。
/// `/bin/sh`（macOS 上是 POSIX 模式的 bash）不在内：它不读 `--init-file` 那条链，认它只会加戏。
fn shell_kind(shell: &str) -> Option<Kind> {
    let name = Path::new(shell).file_name()?.to_str()?;
    match name.strip_prefix('-').unwrap_or(name) {
        "zsh" => Some(Kind::Zsh),
        "bash" => Some(Kind::Bash),
        "fish" => Some(Kind::Fish),
        _ => None,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 把路径变成 shell 里的单引号字面量（内部的 `'` 按 `'\''` 转义）。COFLUX_HOME 可能含空格或引号。
fn sh_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn test_home(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coflux-shellint-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn no_env(_key: &str) -> Option<String> {
        None
    }

    fn env_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// 在 PATH 首段放一个假 `claude`：把自己的 argv 一行一个写进 `<dir>/argv.txt`。
    fn fake_claude(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let script = bin.join("claude");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n",
                sh_quote(&dir.join("argv.txt").to_string_lossy())
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// 找一个真实可执行的 shell；找不到就让用例自己跳过（CI runner 未必装 zsh/fish）。
    fn find_shell(name: &str) -> Option<String> {
        let mut candidates = vec![
            format!("/bin/{name}"),
            format!("/usr/bin/{name}"),
            format!("/usr/local/bin/{name}"),
            format!("/opt/homebrew/bin/{name}"),
        ];
        if let Ok(path) = std::env::var("PATH") {
            candidates.extend(path.split(':').map(|dir| format!("{dir}/{name}")));
        }
        candidates.into_iter().find(|c| Path::new(c).is_file())
    }

    fn argv(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("argv.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn shell_kind_only_accepts_the_three_known_shells() {
        assert_eq!(shell_kind("/bin/zsh"), Some(Kind::Zsh));
        assert_eq!(shell_kind("/opt/homebrew/bin/zsh"), Some(Kind::Zsh));
        assert_eq!(shell_kind("-zsh"), Some(Kind::Zsh), "登录 shell 的前导 - 要剥掉");
        assert_eq!(shell_kind("/usr/local/bin/bash"), Some(Kind::Bash));
        assert_eq!(shell_kind("/usr/bin/fish"), Some(Kind::Fish));
        // /bin/sh 不认（macOS 上它是 POSIX 模式的 bash，根本不读 --init-file 那条链）
        assert_eq!(shell_kind("/bin/sh"), None);
        // 命令终端的包装脚本（crates/worker/src/ops.rs 写的那种）与黑盒里的 COFLUX_SHELL 包装脚本
        assert_eq!(shell_kind("/tmp/coflux-agent-cmd/cmd-123-456.sh"), None);
        assert_eq!(shell_kind("/tmp/coflux-env-shell-x/coflux-test-shell"), None);
        assert_eq!(shell_kind(""), None);
    }

    #[test]
    fn plan_dispatches_per_shell_and_keeps_user_zdotdir() {
        let home = test_home("plan");
        let home_str = home.to_str().unwrap();
        write_files(home_str);
        let root = dir(home_str);

        // zsh：不加参数，只改 ZDOTDIR，并把用户原来的 ZDOTDIR 交给 rc 转发
        let env = env_map(&[("ZDOTDIR", "/home/me/.config/zsh")]);
        let zsh = plan("/bin/zsh", home_str, |key| env.get(key).cloned()).expect("zsh 必须注入");
        assert!(zsh.args.is_empty(), "zsh 靠 ZDOTDIR，不加命令行参数");
        assert_eq!(
            zsh.envs,
            vec![
                (
                    "COFLUX_USER_ZDOTDIR".to_string(),
                    "/home/me/.config/zsh".to_string()
                ),
                (
                    "ZDOTDIR".to_string(),
                    root.join("zsh").to_string_lossy().into_owned()
                ),
            ]
        );
        // 用户没设过 ZDOTDIR：空串（rc 里退回 $HOME），变量仍然存在
        let zsh = plan("/bin/zsh", home_str, no_env).expect("zsh 必须注入");
        assert_eq!(zsh.envs[0], ("COFLUX_USER_ZDOTDIR".to_string(), String::new()));

        // bash：--init-file，无环境变量改动
        let bash = plan("/bin/bash", home_str, no_env).expect("bash 必须注入");
        assert_eq!(
            bash.args,
            vec![
                "--init-file".to_string(),
                root.join("bash/init.bash").to_string_lossy().into_owned()
            ]
        );
        assert!(bash.envs.is_empty());

        // fish：XDG_DATA_DIRS 前置我们的 data dir，原值顺序不变
        let env = env_map(&[("XDG_DATA_DIRS", "/usr/share:/opt/share")]);
        let fish = plan("/usr/bin/fish", home_str, |key| env.get(key).cloned()).expect("fish 必须注入");
        let fish_data = root.join("fish-data").to_string_lossy().into_owned();
        assert_eq!(
            fish.envs,
            vec![(
                "XDG_DATA_DIRS".to_string(),
                format!("{fish_data}:/usr/share:/opt/share")
            )]
        );
        // 原本没设：必须把 XDG 默认值补回去，不能把系统 vendor conf 丢了
        let fish = plan("/usr/bin/fish", home_str, no_env).expect("fish 必须注入");
        assert_eq!(
            fish.envs[0].1,
            format!("{fish_data}:{XDG_DATA_DIRS_DEFAULT}")
        );

        // 认不出的 shell：什么都不做
        assert_eq!(plan("/bin/sh", home_str, no_env), None);
        assert_eq!(plan("/tmp/x/coflux-test-shell", home_str, no_env), None);

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn plan_declines_when_rc_files_are_missing() {
        let home = test_home("missing");
        let home_str = home.to_str().unwrap();
        // 一个字都没写过：绝不能把 ZDOTDIR 指到空目录（那会让 zsh 连用户的 rc 都不读）
        assert_eq!(plan("/bin/zsh", home_str, no_env), None);
        assert_eq!(plan("/bin/bash", home_str, no_env), None);
        assert_eq!(plan("/usr/bin/fish", home_str, no_env), None);

        write_files(home_str);
        assert!(plan("/bin/zsh", home_str, no_env).is_some());
        // 少一个文件也算残缺
        fs::remove_file(dir(home_str).join("zsh/.zshenv")).unwrap();
        assert_eq!(plan("/bin/zsh", home_str, no_env), None);
        fs::remove_file(dir(home_str).join("claude.sh")).unwrap();
        assert_eq!(plan("/bin/bash", home_str, no_env), None);

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn rendered_rc_forwards_to_user_files_and_survives_spaces_in_home() {
        let home = test_home("render with 'quote' and space");
        let home_str = home.to_str().unwrap();
        write_files(home_str);
        let root = dir(home_str);

        let zshrc = fs::read_to_string(root.join("zsh/.zshrc")).unwrap();
        assert!(!zshrc.contains(DIR_PLACEHOLDER), "占位符必须全部替换掉");
        // 用户原来的 .zshrc 先跑，我们的 claude.sh 最后跑
        let user = zshrc.find("$__coflux_user_zdotdir/.zshrc").unwrap();
        let ours = zshrc.find("claude.sh").unwrap();
        assert!(user < ours, "用户 rc 必须在我们的函数定义之前跑");
        // 路径按单引号字面量嵌入（home 里带空格与单引号也不破）
        assert!(
            zshrc.contains(&format!("source {}/claude.sh", sh_quote(&root.to_string_lossy()))),
            "claude.sh 的路径必须是引号安全的: {zshrc}"
        );
        assert!(
            zshrc.contains("ZDOTDIR=\"$COFLUX_USER_ZDOTDIR\""),
            "末尾要把 ZDOTDIR 还给用户"
        );

        let zshenv = fs::read_to_string(root.join("zsh/.zshenv")).unwrap();
        assert!(zshenv.contains("$__coflux_user_zdotdir/.zshenv"), "转发用户的 .zshenv");
        assert!(
            zshenv.contains(&format!("ZDOTDIR={}/zsh", sh_quote(&root.to_string_lossy()))),
            "转发完要把 ZDOTDIR 指回本目录，否则后续文件绕开这条链"
        );
        for file in [".zprofile", ".zlogin"] {
            let text = fs::read_to_string(root.join("zsh").join(file)).unwrap();
            assert!(text.contains(&format!("$__coflux_user_zdotdir/{file}")));
        }

        // bash：source 的文件必须恰好是「今天的非登录交互链」+ 我们这一份，一个不多一个不少
        let init = fs::read_to_string(root.join("bash/init.bash")).unwrap();
        let sourced: Vec<&str> = init
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with(". "))
            .collect();
        assert_eq!(sourced.len(), 3, "多 source 一个文件就是改语义: {sourced:?}");
        assert!(sourced[0].contains("/etc/bash.bashrc"));
        assert!(sourced[1].contains("$HOME/.bashrc"));
        assert!(sourced[2].contains("claude.sh"));

        let fish = fs::read_to_string(root.join("fish-data/fish/vendor_conf.d/coflux.fish")).unwrap();
        assert!(fish.contains("functions -q claude"), "已有 claude 函数时让位");
        assert!(fish.contains("--plugin-dir"));

        fs::remove_dir_all(&home).ok();
    }

    /// 三种分支在真 shell 下的行为：变量指向存在目录 → 带 flag；空 / 指向不存在的目录 → 与今天一致。
    fn assert_three_branches(shell: &str, run: impl Fn(&Path, &Path, &str) -> Vec<String>) {
        let home = test_home("branches");
        let plugin = home.join("plugin dir");
        fs::create_dir_all(&plugin).unwrap();
        let bin = fake_claude(&home);

        let with = run(&home, &bin, plugin.to_str().unwrap());
        assert_eq!(
            with,
            vec![
                "--plugin-dir".to_string(),
                plugin.to_string_lossy().into_owned(),
                "chat".to_string(),
                "a b".to_string(),
            ],
            "{shell}：变量指向存在的目录时追加 --plugin-dir，用户自己的参数原样保留（含带空格的）"
        );

        let empty = run(&home, &bin, "");
        assert_eq!(
            empty,
            vec!["chat".to_string(), "a b".to_string()],
            "{shell}：变量为空 = 今天的 claude（这就是逃生口）"
        );

        let gone = run(&home, &bin, &home.join("nope").to_string_lossy());
        assert_eq!(
            gone,
            vec!["chat".to_string(), "a b".to_string()],
            "{shell}：变量指向不存在的目录也退化成今天的 claude"
        );

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn zsh_function_translates_the_variable_into_plugin_dir() {
        let Some(zsh) = find_shell("zsh") else {
            eprintln!("跳过：本机没有 zsh");
            return;
        };
        assert_three_branches("zsh", |home, bin, plugin_dir| {
            let home_str = home.to_str().unwrap();
            write_files(home_str);
            let path = format!(
                "{}:{}",
                bin.to_string_lossy(),
                std::env::var("PATH").unwrap_or_default()
            );
            // -d 跳过 /etc/z*（本机配置不该影响判定），rc 仍从 ZDOTDIR 读；-i 才会读 .zshrc
            let output = Command::new(&zsh)
                .args(["-d", "-i", "-c", "claude chat 'a b'"])
                .env("PATH", &path)
                .env("HOME", home_str)
                .env("TERM", "dumb")
                .env("ZDOTDIR", dir(home_str).join("zsh"))
                .env("COFLUX_USER_ZDOTDIR", "")
                .env("COFLUX_CLAUDE_PLUGIN_DIR", plugin_dir)
                .stdin(Stdio::null())
                .output()
                .expect("起 zsh");
            assert!(
                output.status.success(),
                "zsh 必须正常退出: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            argv(home)
        });
    }

    #[test]
    fn bash_function_translates_the_variable_into_plugin_dir() {
        let Some(bash) = find_shell("bash") else {
            eprintln!("跳过：本机没有 bash");
            return;
        };
        assert_three_branches("bash", |home, bin, plugin_dir| {
            let home_str = home.to_str().unwrap();
            write_files(home_str);
            let path = format!(
                "{}:{}",
                bin.to_string_lossy(),
                std::env::var("PATH").unwrap_or_default()
            );
            let init = dir(home_str).join("bash/init.bash");
            let output = Command::new(&bash)
                .args([
                    "--noprofile",
                    "--init-file",
                    init.to_str().unwrap(),
                    "-i",
                    "-c",
                    "claude chat 'a b'",
                ])
                .env("PATH", &path)
                .env("HOME", home_str)
                .env("TERM", "dumb")
                .env("COFLUX_CLAUDE_PLUGIN_DIR", plugin_dir)
                .stdin(Stdio::null())
                .output()
                .expect("起 bash");
            assert!(
                output.status.success(),
                "bash 必须正常退出: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            argv(home)
        });
    }

    #[test]
    fn zsh_chain_runs_user_rc_in_order_including_a_user_set_zdotdir() {
        let Some(zsh) = find_shell("zsh") else {
            eprintln!("跳过：本机没有 zsh");
            return;
        };
        let home = test_home("chain");
        let home_str = home.to_str().unwrap();
        write_files(home_str);
        let bin = fake_claude(&home);
        let plugin = home.join("plugin");
        fs::create_dir_all(&plugin).unwrap();

        // 用户自己设过 ZDOTDIR：rc 必须从那里找他的启动文件，而不是 $HOME
        let user_zdotdir = home.join("user zdotdir");
        fs::create_dir_all(&user_zdotdir).unwrap();
        let order = home.join("order.txt");
        let log = |name: &str| {
            format!(
                "printf '%s\\n' {} >> {}\nexport COFLUX_SAW_ZDOTDIR_IN_{}=\"$ZDOTDIR\"\n",
                sh_quote(name),
                sh_quote(&order.to_string_lossy()),
                name.to_uppercase(),
            )
        };
        fs::write(user_zdotdir.join(".zshenv"), log("zshenv")).unwrap();
        fs::write(user_zdotdir.join(".zshrc"), log("zshrc")).unwrap();
        // $HOME 下放同名文件：用户设了 ZDOTDIR 时这两份**不该**被读到
        fs::write(home.join(".zshenv"), "printf 'HOME_ZSHENV\\n' >> /dev/stderr\nexit 17\n").unwrap();

        let path = format!(
            "{}:{}",
            bin.to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        );
        let output = Command::new(&zsh)
            .args([
                "-d",
                "-i",
                "-c",
                "claude go; printf 'ZDOTDIR=%s\\n' \"${ZDOTDIR-unset}\"; printf 'SAW=%s\\n' \"$COFLUX_SAW_ZDOTDIR_IN_ZSHRC\"",
            ])
            .env("PATH", &path)
            .env("HOME", home_str)
            .env("TERM", "dumb")
            .env("ZDOTDIR", dir(home_str).join("zsh"))
            .env("COFLUX_USER_ZDOTDIR", &user_zdotdir)
            .env("COFLUX_CLAUDE_PLUGIN_DIR", &plugin)
            .stdin(Stdio::null())
            .output()
            .expect("起 zsh");
        assert!(
            output.status.success(),
            "zsh 必须正常退出: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert_eq!(
            fs::read_to_string(&order).unwrap(),
            "zshenv\nzshrc\n",
            "用户的启动文件按 zsh 原顺序各跑一次，一个不少一个不多"
        );
        assert!(
            stdout.contains(&format!("SAW={}", user_zdotdir.to_string_lossy())),
            "用户 rc 跑的时候 $ZDOTDIR 必须是他自己的目录: {stdout}"
        );
        assert!(
            stdout.contains(&format!("ZDOTDIR={}", user_zdotdir.to_string_lossy())),
            "rc 跑完 ZDOTDIR 要还给用户: {stdout}"
        );
        assert_eq!(
            argv(&home),
            vec![
                "--plugin-dir".to_string(),
                plugin.to_string_lossy().into_owned(),
                "go".to_string()
            ],
            "转发完用户 rc 之后，claude 仍然带上插件目录"
        );

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn user_alias_or_function_named_claude_wins() {
        let Some(zsh) = find_shell("zsh") else {
            eprintln!("跳过：本机没有 zsh");
            return;
        };
        let home = test_home("yield");
        let home_str = home.to_str().unwrap();
        write_files(home_str);
        let bin = fake_claude(&home);
        let plugin = home.join("plugin");
        fs::create_dir_all(&plugin).unwrap();
        let path = format!(
            "{}:{}",
            bin.to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        );
        let claude_sh = dir(home_str).join("claude.sh");

        // 用户自己的函数：我们让位，他的定义原样生效。函数是**运行期**查找，所以怎么喂给 shell 都行，
        // 这一半直接用 `-c`。（别名不行，见下一半。）
        let script = format!(
            "claude() {{ print USER_FUNCTION; }}\nsource {}\nclaude go\n",
            sh_quote(&claude_sh.to_string_lossy())
        );
        let output = Command::new(&zsh)
            .args(["-d", "-f", "-c", script.as_str()])
            .env("PATH", &path)
            .env("HOME", home_str)
            .env("TERM", "dumb")
            .env("COFLUX_CLAUDE_PLUGIN_DIR", &plugin)
            .stdin(Stdio::null())
            .output()
            .expect("起 zsh");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "USER_FUNCTION",
            "用户已有 claude 函数时必须让位，不覆盖他的定义"
        );
        assert!(!home.join("argv.txt").exists(), "让位就不该执行到真 claude");

        // 用户自己的别名：连解析都不能碰（`claude() {` 在命令位会被别名展开成语法错误）。
        // 别名是**解析期**展开的，所以脚本必须落成文件再跑：`-c` 的整串是一个解析单位，在同一串里
        // 定义的别名对后面几行不生效（真实 rc 链不是这样——rc 文件与用户后来敲的那行是两个解析单位，
        // zsh 读脚本文件同样是一条命令一条命令地解析）。拿 `-c` 验别名等于验 shell 的解析时机，不是本文件的事。
        let script_path = home.join("user-alias.zsh");
        fs::write(
            &script_path,
            format!(
                "alias claude='print USER_ALIAS'\nsource {}\nclaude\n",
                sh_quote(&claude_sh.to_string_lossy())
            ),
        )
        .unwrap();
        let output = Command::new(&zsh)
            .args(["-d", "-f", script_path.to_str().unwrap()])
            .env("PATH", &path)
            .env("HOME", home_str)
            .env("TERM", "dumb")
            .env("COFLUX_CLAUDE_PLUGIN_DIR", &plugin)
            .stdin(Stdio::null())
            .output()
            .expect("起 zsh");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "USER_ALIAS",
            "用户已有 claude 别名时必须让位，且不能出语法错误"
        );
        // 这条才分得清「让位」与「悄悄跑了真 claude」：别名生效就不该有任何进程执行到 PATH 上的 claude
        assert!(!home.join("argv.txt").exists(), "让位就不该执行到真 claude");

        fs::remove_dir_all(&home).ok();
    }
}
