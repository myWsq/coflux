//! coflux（Rust 版）—— 跑在 coflux 终端里的 agent 与 Claude 插件 hook 用的那组命令（plan 112）。
//!
//! 与 npm 版 `packages/cli/coflux.mjs` 同名并存：coflux 终端里靠 supervisor 前置的
//! `$COFLUX_HOME/bin` 命中本二进制（零 node 依赖，供桌面版内置，plan 113），用户自己的终端里命中
//! npm 版。两版共享账号 API；本 crate 提供账号登录、跨设备操作与本地 Agent 命令，逐命令对齐请求体、
//! stdout 短语与退出码；宿主管理由 Coflux.app 或 cofluxd 独立负责。

mod account;
mod args;
mod commands;
mod gateway;
mod integration;
mod text;

/// `✗ <msg>` 到 stderr 并以 1 退出（node 版 `die`）。
pub fn die(message: &str) -> ! {
    eprintln!("✗ {message}");
    std::process::exit(1)
}

const HELP: &str = "账号命令（JSON 输出）：
  coflux login --username <账号> --password-stdin [--server https://…]
  coflux whoami | logout
  coflux device list | project list | workspace list
  coflux workspace new --project <id> --branch <分支> [--existing-branch]
  coflux workspace rename <id> --name <名称> | workspace remove <id>
  coflux terminal new --workspace <id> [--cmd <命令>] [--title <标题>]
  coflux terminal list [--device <id>] [--workspace <id>]
  coflux terminal read|wait|send|stop|remove <id> --remote
  coflux ports --remote
  在 Coflux 应用已登录时自动使用应用账号；独立 CLI 可自行登录。
  命令退出或升级 CLI 不会结束已运行的终端。

coflux —— 账号与终端操作

  本机宿主管理请使用 Coflux.app 或 cofluxd。

  coflux hook <claude|codex>   [agent hook 信使] 读 stdin/argv 的事件 JSON，转发给本机 daemon
                          （在 claude/codex 的 hook 配置里指向本命令；失败静默，不干扰 agent）

  以下几条供**跑在 coflux 终端里的 agent** 调用，把工作变成用户看得见、能接管的东西：

  coflux terminal new [--cmd \"<命令>\"] [--title \"<标题>\"]
                          开一个真实终端，用户在 coflux 侧栏能看到并随时接管
                          带 --cmd = 作业终端：命令在登录 shell 里跑完即退出并带退出码，输出另
                          落一份日志供 read 回读（代价：stdout 是管道，不是 tty）
                          不带 --cmd = 会话终端：工作区目录下的常驻登录 shell，stdin/stdout 都是
                          真 tty（能跑 vim/htop、有颜色），先 read 等提示符再 send，送 exit 才结束
  coflux terminal list   列出本工作区的终端（含 status / 退出码）
  coflux terminal read <taskId> [--lines N]
                          读某个终端的内容（纯文本，默认最后 200 行；终端已退出也能读）
  coflux terminal wait <taskId> [--timeout <秒>]
                          阻塞等到该终端退出，打印退出码（默认超时 30 分钟）
  coflux terminal send <taskId> --text \"<文本>\" [--enter]
                          往终端里输入文本（--enter 追加回车）。用户正在接管时会被拒
  coflux notify \"<一句话>\"  叫人：工作区在侧栏转为「等待交互」并显示这句话
  coflux progress \"<一句话>\"  播报进度：显示在工作区卡片上，被下一条覆盖（不打扰用户）
  coflux ports           列出本工作区的监听端口及可直接打开的预览 URL
  coflux workspace       一行 JSON 报出「我在哪」：workspaceId（cwd 所在的有效工作区，本地命令
                          都落在它上面）、path、owningWorkspaceId（本终端此刻归属哪个工作区）、
                          moved。用 /cd 挪进另一个 coflux 工作区后用它确认目标，跨工作区操作时也传这个
                          workspaceId
  coflux workspace enter <path>
                          进入同仓库工作区并迁移当前终端；受管 Codex 会话记住选择供恢复/压缩使用。
                          后续工具必须显式使用返回路径；不会改变宿主默认 cwd 或沙箱权限
  coflux workspace locate [path]
                          把本终端的**归属**搬到 path（缺省=当前目录）所属的工作区：进入/离开
                          worktree 后 coflux 跟着走，未登记的同仓库 worktree 先登记出一个子工作区。
                          插件自动调，一般不用手敲
  coflux workspace forget <path>
                          该 worktree 已被删掉：其下所有终端搬回项目主工作区、工作区记录消失
                          （不执行 git worktree remove）

agent 命令的环境变量：COFLUX_AGENT_TIMEOUT_MS 收窄单次请求的等待上限（默认 30000，只能调小），
供有硬超时的 hook 脚本用——到点干净失败，好过被宿主杀在半路。";

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().is_some_and(|arg| arg == "agent") {
        if let Err(error) = integration::run(&raw[1..]) { die(&error); }
        return;
    }
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
    if account::handles(&parsed) {
        if let Err(error) = account::run(&parsed) { die(&error); }
        return;
    }
    match command {
        "hook" => commands::run_hook(&parsed),
        "terminal" => commands::run_terminal(&parsed),
        "notify" => commands::run_notify(&parsed),
        "progress" => commands::run_progress(&parsed),
        "ports" => commands::run_ports(),
        "workspace" => commands::run_workspace(&parsed),
        other => {
            die(&format!("未知命令: {other}\n本机宿主请使用 Coflux.app 或 cofluxd。\n\n{HELP}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_keeps_agent_phrases_used_by_skill_docs() {
        for phrase in ["coflux terminal new", "coflux terminal read <taskId>", "coflux notify", "coflux progress", "coflux ports", "coflux workspace locate", "coflux hook <claude|codex>", "COFLUX_AGENT_TIMEOUT_MS"] {
            assert!(HELP.contains(phrase), "HELP 缺 {phrase}");
        }
    }
}
