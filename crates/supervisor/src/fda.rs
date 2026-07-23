//! macOS「完全磁盘访问权限」(FDA) 探测——见 plan 026。
//!
//! LaunchAgent 直接执行 supervisor 二进制,TCC 的 responsible process 就是它自己;
//! 探测必须在本进程内做,cofluxd(CLI)去试读保护路径测的是终端 App 的权限,失真。
//!
//! 探测法:试读纯 FDA 保护目录 `$HOME/Library/Safari`(注意是真实 $HOME,不是
//! COFLUX_HOME——dev 模式下二者不同,COFLUX_HOME 下没有这个目录)。这类目录不会像
//! 桌面/文稿/下载那样触发 per-folder TCC 弹窗,故探测本身不会造成新的弹窗。
//!
//! 结果落盘到 `$COFLUX_HOME/fda-status`,供 cofluxd CLI 展示/引导(现有先例:worker.pid)。
//! 全程不 panic、不阻塞——辅助能力,失败一律静默降级为 "unknown"。

/// 探测并把结果写入 `{home}/fda-status`(纯文本:granted/denied/unknown)。非 macOS 平台空操作。
pub fn write_status(home: &str) {
    imp::write_status(home)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io::ErrorKind;

    pub fn write_status(home: &str) {
        let status = detect();
        let _ = std::fs::write(format!("{home}/fda-status"), status);
    }

    fn detect() -> &'static str {
        let real_home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => return "unknown",
        };
        match std::fs::read_dir(format!("{real_home}/Library/Safari")) {
            Ok(_) => "granted",
            Err(e) if e.kind() == ErrorKind::PermissionDenied => "denied",
            Err(_) => "unknown",
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn write_status(_home: &str) {}
}
