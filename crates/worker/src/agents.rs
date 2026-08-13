//! Agent 进程探测（plan 073）：给定 PTY 会话根 pid，在其进程树内识别内置名单里的
//! agent CLI（claude/codex）。三条匹配规则互补：进程名（comm）== 名单项；
//! basename(argv[0]) == 名单项；argv[0] 是解释器（node/bun 等）时 basename(argv[1])
//! == 名单项——claude 可能以 node 包装运行，光看进程名会漏。
//!
//! 与 ports.rs 同一契约：探测失败（权限不足/进程已退出/平台不支持）一律静默降级为
//! 「无 agent」，绝不 panic、不向上抛错——辅助能力缺失不影响 PTY 等主功能。

use std::collections::HashMap;

use coflux_protocol::wire;

use crate::ports;

/// 内置 agent 名单。加新名字 = 改这里 + 发版（worker 热升级可达，无需动 supervisor）。
const AGENT_NAMES: &[&str] = &["claude", "codex"];

/// argv[0] 是这些解释器时才看 argv[1]（npm/脚本包装的 agent 常见形态）；
/// 不无条件看 argv[1]，避免 `vim claude` 这类"参数恰好叫 claude"的误报。
const INTERPRETERS: &[&str] = &["node", "bun", "deno", "python", "python3", "sh", "bash", "zsh"];

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn match_agent(comm: &str, argv: &[String]) -> Option<&'static str> {
    for &name in AGENT_NAMES {
        if comm == name {
            return Some(name);
        }
        if let Some(arg0) = argv.first() {
            if basename(arg0) == name {
                return Some(name);
            }
            if INTERPRETERS.contains(&basename(arg0)) {
                if let Some(arg1) = argv.get(1) {
                    if basename(arg1) == name {
                        return Some(name);
                    }
                }
            }
        }
    }
    None
}

/// 对每个存活会话扫描其进程树，树内任一进程命中即算该会话存在 agent（首个命中的名字）。
/// 返回按 session_id 排序的全量清单——多次调用在进程集合不变时输出完全一致，
/// 供「变化才发」的相等比较使用（与 ports 的 build_ports_update 同一约定）。
pub fn detect_session_agents(alive: &HashMap<String, (String, i32)>) -> Vec<wire::SessionAgentRef> {
    let mut sessions: Vec<wire::SessionAgentRef> = alive
        .iter()
        .filter_map(|(session_id, (task_id, pid))| {
            detect_in_tree(*pid).map(|agent| wire::SessionAgentRef {
                session_id: session_id.clone(),
                task_id: task_id.clone(),
                agent: agent.to_string(),
            })
        })
        .collect();
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    sessions
}

fn detect_in_tree(root_pid: i32) -> Option<&'static str> {
    for pid in ports::process_tree(root_pid) {
        let comm = imp::comm(pid).unwrap_or_default();
        let argv = imp::argv(pid).unwrap_or_default();
        if let Some(agent) = match_agent(&comm, &argv) {
            return Some(agent);
        }
    }
    None
}

#[cfg(target_os = "linux")]
mod imp {
    /// /proc/<pid>/comm：被 exec 文件的 basename（shebang 脚本即脚本名，截断 15 字节——
    /// claude/codex 都不超）。
    pub fn comm(pid: i32) -> Option<String> {
        std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string())
    }

    pub fn argv(pid: i32) -> Option<Vec<String>> {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        Some(
            raw.split(|byte| *byte == 0)
                .filter(|part| !part.is_empty())
                .map(|part| String::from_utf8_lossy(part).into_owned())
                .collect(),
        )
    }
}

#[cfg(target_os = "macos")]
mod imp {
    /// proc_name（pbi_name）：被 exec 文件的 basename，同 uid 无特权可读。
    pub fn comm(pid: i32) -> Option<String> {
        libproc::proc_pid::name(pid).ok()
    }

    /// KERN_PROCARGS2 布局：c_int argc | exec_path\0 | \0 填充 | argv[0]\0 … argv[argc-1]\0 | env…
    /// 同 uid 无特权可读；两次 sysctl 之间进程可能退出，任何失败都返回 None。
    pub fn argv(pid: i32) -> Option<Vec<String>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        let rc = unsafe {
            libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0)
        };
        if rc != 0 || size <= std::mem::size_of::<libc::c_int>() {
            return None;
        }
        let mut buf = vec![0u8; size];
        let rc = unsafe {
            libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0)
        };
        if rc != 0 {
            return None;
        }
        buf.truncate(size);
        parse_procargs2(&buf)
    }

    fn parse_procargs2(buf: &[u8]) -> Option<Vec<String>> {
        let int_len = std::mem::size_of::<libc::c_int>();
        let argc = libc::c_int::from_ne_bytes(buf.get(..int_len)?.try_into().ok()?).max(0) as usize;
        let rest = buf.get(int_len..)?;
        // 跳过 exec_path 及其后的 NUL 填充，落到 argv[0] 起点
        let mut index = rest.iter().position(|byte| *byte == 0)?;
        while index < rest.len() && rest[index] == 0 {
            index += 1;
        }
        let mut args = Vec::with_capacity(argc.min(64));
        let mut start = index;
        for end in index..rest.len() {
            if rest[end] == 0 {
                args.push(String::from_utf8_lossy(&rest[start..end]).into_owned());
                start = end + 1;
                if args.len() >= argc {
                    break;
                }
            }
        }
        Some(args)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    pub fn comm(_pid: i32) -> Option<String> {
        None
    }
    pub fn argv(_pid: i32) -> Option<Vec<String>> {
        None
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// 名为 claude 的脚本进程要被命中：Linux 靠 comm（= 脚本 basename），macOS 至少靠
    /// argv（argv[0]=/bin/sh 是解释器 → 看 argv[1] 的 basename）——两条规则互补正是
    /// 跨平台设计意图。树根直接用脚本进程自身 pid，不依赖测试进程树（并行测试互不干扰）。
    #[test]
    fn detects_script_named_claude() {
        let dir = std::env::temp_dir().join(format!("coflux-agents-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let script = dir.join("claude");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").expect("write script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let mut child = std::process::Command::new(&script).spawn().expect("spawn claude script");
        let alive = HashMap::from([("s1".to_string(), ("t1".to_string(), child.id() as i32))]);
        // fork 到 exec 完成有短暂窗口（comm/argv 还是旧值），轮询到命中为止
        let mut found = Vec::new();
        for _ in 0..50 {
            found = detect_session_agents(&alive);
            if !found.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(found.len(), 1, "expected claude detected, got {found:?}");
        assert_eq!(found[0].agent, "claude");
        assert_eq!(found[0].session_id, "s1");
        assert_eq!(found[0].task_id, "t1");
    }

    /// 安全边界：普通进程树（sleep）绝不能报出 agent。
    #[test]
    fn plain_tree_has_no_agent() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let alive = HashMap::from([("s1".to_string(), ("t1".to_string(), child.id() as i32))]);
        let found = detect_session_agents(&alive);
        let _ = child.kill();
        let _ = child.wait();
        assert!(found.is_empty(), "no agent expected, got {found:?}");
    }

    /// `vim claude` 这类"参数恰好叫 agent 名"不误报：argv[0] 不是解释器就不看 argv[1]。
    #[test]
    fn non_interpreter_argv1_does_not_match() {
        assert_eq!(match_agent("vim", &["vim".to_string(), "claude".to_string()]), None);
        assert_eq!(match_agent("node", &["node".to_string(), "/opt/bin/claude".to_string()]), Some("claude"));
        assert_eq!(match_agent("codex", &[]), Some("codex"));
        assert_eq!(match_agent("zsh", &["-zsh".to_string()]), None);
    }
}
