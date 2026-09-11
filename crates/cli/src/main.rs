//! cofluxd（Rust 版）—— 跑在 coflux 终端里的 agent 与 Claude 插件 hook 用的那组命令（plan 112）。
//!
//! 与 npm 版 `packages/cli/cofluxd.mjs` 同名并存：coflux 终端里靠 supervisor 前置的
//! `$COFLUX_HOME/bin` 命中本二进制（零 node 依赖，供桌面版内置，plan 113），用户自己的终端里命中
//! npm 版。node 版仍是行为与文案的真相源——本 crate 只含 agent 侧命令，逐命令对齐它的请求体、
//! stdout 短语与退出码；管理类子命令（up/down/update/restart/status/doctor/logs/fda/uninstall）
//! 不重写，打到这里时明确拒绝并指向 Coflux.app（exit 2），与「未知命令」（exit 1）区分。

mod args;
mod commands;
mod gateway;
mod text;

/// `✗ <msg>` 到 stderr 并以 1 退出（node 版 `die`）。
pub fn die(message: &str) -> ! {
    eprintln!("✗ {message}");
    std::process::exit(1)
}

/// 由 Coflux.app 接管的管理类子命令：识别出来就明确拒绝，而不是当未知命令。
const MANAGED_COMMANDS: &[&str] = &[
    "up", "down", "update", "restart", "status", "doctor", "logs", "fda", "uninstall",
];

/// node 版已迁移/合并掉的旧命令，沿用它的提示（仍按未知命令处理）。
fn migrated_hint(command: &str) -> Option<&'static str> {
    match command {
        "onboard" => Some("onboard 已并入 up，直接运行 `cofluxd up`"),
        "reload" => Some("reload 已并入 up（up 现幂等，会按 settings.json 重装服务并重启），直接运行 `cofluxd up`"),
        _ => None,
    }
}

pub fn is_managed_command(command: &str) -> bool {
    MANAGED_COMMANDS.contains(&command)
}

pub fn managed_refusal(command: &str) -> String {
    format!(
        "cofluxd {command}：本机 daemon 由 Coflux.app 管理——启动/停止/更新/状态/诊断请在 Coflux.app 里操作\n（这份 cofluxd 是 app 内置的 agent 命令版，只含 terminal / notify / progress / ports / workspace / hook；见 cofluxd --help）"
    )
}

const HELP: &str = "cofluxd —— coflux agent 命令（Coflux.app 内置版）

  本机 daemon 的安装/启动/停止/更新/状态由 Coflux.app 管理；up / down / update / restart / status /
  doctor / logs / fda / uninstall 在这份 cofluxd 里不可用（Linux / 无头机请用 npm 版 cofluxd）。

  cofluxd hook <claude|codex>   [agent hook 信使] 读 stdin/argv 的事件 JSON，转发给本机 daemon
                          （在 claude/codex 的 hook 配置里指向本命令；失败静默，不干扰 agent）

  以下几条供**跑在 coflux 终端里的 agent** 调用，把工作变成用户看得见、能接管的东西：

  cofluxd terminal new [--cmd \"<命令>\"] [--title \"<标题>\"]
                          开一个真实终端，用户在 coflux 侧栏能看到并随时接管
                          带 --cmd = 作业终端：命令在登录 shell 里跑完即退出并带退出码，输出另
                          落一份日志供 read 回读（代价：stdout 是管道，不是 tty）
                          不带 --cmd = 会话终端：工作区目录下的常驻登录 shell，stdin/stdout 都是
                          真 tty（能跑 vim/htop、有颜色），先 read 等提示符再 send，送 exit 才结束
  cofluxd terminal list   列出本工作区的终端（含 status / 退出码）
  cofluxd terminal read <taskId> [--lines N]
                          读某个终端的内容（纯文本，默认最后 200 行；终端已退出也能读）
  cofluxd terminal wait <taskId> [--timeout <秒>]
                          阻塞等到该终端退出，打印退出码（默认超时 30 分钟）
  cofluxd terminal send <taskId> --text \"<文本>\" [--enter]
                          往终端里输入文本（--enter 追加回车）。用户正在接管时会被拒
  cofluxd notify \"<一句话>\"  叫人：工作区在侧栏转为「等待交互」并显示这句话
  cofluxd progress \"<一句话>\"  播报进度：显示在工作区卡片上，被下一条覆盖（不打扰用户）
  cofluxd ports           列出本工作区的监听端口及可直接打开的预览 URL
  cofluxd workspace       一行 JSON 报出「我在哪」：workspaceId（cwd 所在的有效工作区，本地命令
                          都落在它上面）、path、owningWorkspaceId（本终端此刻归属哪个工作区）、
                          moved。用 /cd 挪进另一个 coflux 工作区后用它确认目标，调 MCP 时也传这个
                          workspaceId
  cofluxd workspace locate [path]
                          把本终端的**归属**搬到 path（缺省=当前目录）所属的工作区：进入/离开
                          worktree 后 coflux 跟着走，未登记的同仓库 worktree 先登记出一个子工作区。
                          插件自动调，一般不用手敲
  cofluxd workspace forget <path>
                          该 worktree 已被删掉：其下所有终端搬回项目主工作区、工作区记录消失
                          （不执行 git worktree remove）

agent 命令的环境变量：COFLUX_AGENT_TIMEOUT_MS 收窄单次请求的等待上限（默认 30000，只能调小），
供有硬超时的 hook 脚本用——到点干净失败，好过被宿主杀在半路。";

fn main() {
    let parsed = match args::parse(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(error) => die(&format!("参数错误：{error}\n\n{HELP}")),
    };
    let command = parsed.positional(0);
    if parsed.flag("help") || command == Some("help") || command.is_none() {
        println!("{HELP}");
        return;
    }
    let command = command.unwrap_or_default();
    if is_managed_command(command) {
        eprintln!("✗ {}", managed_refusal(command));
        std::process::exit(2);
    }
    match command {
        "hook" => commands::run_hook(&parsed),
        "terminal" => commands::run_terminal(&parsed),
        "notify" => commands::run_notify(&parsed),
        "progress" => commands::run_progress(&parsed),
        "ports" => commands::run_ports(),
        "workspace" => commands::run_workspace(&parsed),
        other => {
            let hint = migrated_hint(other).map(|hint| format!("\n{hint}")).unwrap_or_default();
            die(&format!("未知命令: {other}{hint}\n\n{HELP}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_commands_are_recognized_explicitly() {
        for command in ["up", "down", "update", "restart", "status", "doctor", "logs", "fda", "uninstall"] {
            assert!(is_managed_command(command), "{command} 应被识别为管理类命令");
        }
        for command in ["terminal", "notify", "progress", "ports", "workspace", "hook", "onboard", "bogus"] {
            assert!(!is_managed_command(command), "{command} 不是管理类命令");
        }
    }

    #[test]
    fn refusal_points_to_the_desktop_app() {
        let text = managed_refusal("status");
        assert!(text.starts_with("cofluxd status："));
        assert!(text.contains("Coflux.app"));
    }

    #[test]
    fn migrated_hints_follow_node() {
        assert!(migrated_hint("onboard").unwrap().contains("cofluxd up"));
        assert!(migrated_hint("reload").is_some());
        assert!(migrated_hint("terminal").is_none());
    }

    #[test]
    fn help_keeps_agent_phrases_used_by_skill_docs() {
        for phrase in ["cofluxd terminal new", "cofluxd terminal read <taskId>", "cofluxd notify", "cofluxd progress", "cofluxd ports", "cofluxd workspace locate", "cofluxd hook <claude|codex>", "COFLUX_AGENT_TIMEOUT_MS"] {
            assert!(HELP.contains(phrase), "HELP 缺 {phrase}");
        }
    }
}
