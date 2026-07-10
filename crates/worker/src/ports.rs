//! 端口探测:给定 PTY 会话根 pid,枚举其进程树(自身 + 全部子孙)里处于 LISTEN 状态的
//! TCP 端口。只覆盖该进程树——机器上其它进程(系统服务、用户手动跑的进程)的端口绝不
//! 上报,这是产品安全边界(见 plan 005 Requirement)。
//!
//! Linux 手撸 /proc,macOS 走 libproc(同 uid 无特权操作,两者都不需要 root)。
//! 探测失败(权限不足/进程已退出/平台不支持)一律静默降级为空集,绝不 panic、不向上
//! 抛错——辅助能力缺失不应影响 PTY/隧道等主功能。
//!
//! 只报端口号,不区分地址族:v6 通配监听(`::`,node/vite 默认常绑)与 v4 一样计入。

use std::collections::HashSet;

/// 给定进程树根 pid,返回其自身与全部子孙进程中处于 LISTEN 状态的 TCP 端口集合。
pub fn listening_ports(root_pid: i32) -> HashSet<u16> {
    let pids = imp::process_tree(root_pid);
    imp::listen_ports_for_pids(&pids)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashSet;

    use libproc::bsd_info::BSDInfo;
    use libproc::file_info::{pidfdinfo, ListFDs, ProcFDType};
    use libproc::net_info::{SocketFDInfo, SocketInfoKind, TcpSIState};
    use libproc::proc_pid::{listpidinfo, pidinfo};
    use libproc::processes::{pids_by_type, ProcFilter};

    /// root_pid 自身 + 全部子孙 pid(BFS,按 ppid 关系逐层展开)。
    pub fn process_tree(root_pid: i32) -> Vec<i32> {
        let mut result = vec![root_pid];
        let mut seen: HashSet<i32> = [root_pid].into_iter().collect();
        let mut frontier = vec![root_pid];
        while let Some(pid) = frontier.pop() {
            let children = pids_by_type(ProcFilter::ByParentProcess { ppid: pid as u32 }).unwrap_or_default();
            for c in children {
                let c = c as i32;
                if seen.insert(c) {
                    result.push(c);
                    frontier.push(c);
                }
            }
        }
        result
    }

    pub fn listen_ports_for_pids(pids: &[i32]) -> HashSet<u16> {
        let mut ports = HashSet::new();
        for &pid in pids {
            let Ok(info) = pidinfo::<BSDInfo>(pid, 0) else { continue };
            let Ok(fds) = listpidinfo::<ListFDs>(pid, info.pbi_nfiles as usize) else { continue };
            for fd in fds {
                if !matches!(ProcFDType::from(fd.proc_fdtype), ProcFDType::Socket) {
                    continue;
                }
                let Ok(sock) = pidfdinfo::<SocketFDInfo>(pid, fd.proc_fd) else { continue };
                if !matches!(SocketInfoKind::from(sock.psi.soi_kind), SocketInfoKind::Tcp) {
                    continue;
                }
                // union 访问是 unsafe:soi_kind==Tcp 时 soi_proto 的活跃成员保证是 pri_tcp（Darwin ABI 约定）。
                let tcp = unsafe { sock.psi.soi_proto.pri_tcp };
                if !matches!(TcpSIState::from(tcp.tcpsi_state), TcpSIState::Listen) {
                    continue;
                }
                // insi_lport 是网络字节序(大端)存在 c_int 里的 16bit 值,手动换回本机序
                // (照抄 net_info.rs 文档示例的写法,避免对 from_be 在符号扩展上的假设出错)。
                let raw = tcp.tcpsi_ini.insi_lport as u32;
                let mut port: u32 = 0;
                port |= (raw >> 8) & 0x00ff;
                port |= (raw << 8) & 0xff00;
                let port = port as u16;
                if port != 0 {
                    ports.insert(port);
                }
            }
        }
        ports
    }

    /// 仅供本模块单测使用:取得某 pid 的父 pid(BSDInfo.pbi_ppid)。cfg(test) 限定,
    /// 避免正常构建里出现 dead code 警告。
    #[cfg(test)]
    pub(crate) fn parent_pid(pid: i32) -> Option<i32> {
        pidinfo::<BSDInfo>(pid, 0).ok().map(|info| info.pbi_ppid as i32)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::Path;

    /// root_pid 自身 + 全部子孙 pid。优先读 `/proc/<pid>/task/*/children`(主流内核默认开
    /// CONFIG_PROC_CHILDREN);单个 pid 读不到时才退化到全量 `/proc/*/stat` 反向建 ppid 表
    /// (2s 周期下若长期走这条路径,全量遍历成本由执行者接受,见 plan Landmines)。
    pub fn process_tree(root_pid: i32) -> Vec<i32> {
        let mut result = vec![root_pid];
        let mut seen: HashSet<i32> = [root_pid].into_iter().collect();
        let mut frontier = vec![root_pid];
        let mut fallback: Option<HashMap<i32, Vec<i32>>> = None;
        while let Some(pid) = frontier.pop() {
            let children = match children_via_proc(pid) {
                Some(c) => c,
                None => fallback.get_or_insert_with(build_ppid_map).get(&pid).cloned().unwrap_or_default(),
            };
            for c in children {
                if seen.insert(c) {
                    result.push(c);
                    frontier.push(c);
                }
            }
        }
        result
    }

    /// 读 `/proc/<pid>/task/*/children` 取直接子进程(多线程进程需汇总每个 tid 的 children)。
    /// 文件不存在(内核未开该 config 或进程已退出)返回 None,交调用方走全量兜底。
    fn children_via_proc(pid: i32) -> Option<Vec<i32>> {
        let task_dir = format!("/proc/{pid}/task");
        let entries = fs::read_dir(&task_dir).ok()?;
        let mut out = Vec::new();
        let mut any_children_file = false;
        for entry in entries.flatten() {
            let children_path = entry.path().join("children");
            if let Ok(content) = fs::read_to_string(&children_path) {
                any_children_file = true;
                out.extend(content.split_whitespace().filter_map(|tok| tok.parse::<i32>().ok()));
            }
        }
        any_children_file.then_some(out)
    }

    /// 兜底:全量遍历 `/proc/*/stat` 建 pid -> children 反向表(一次扫描覆盖全部 pid)。
    fn build_ppid_map() -> HashMap<i32, Vec<i32>> {
        let mut map: HashMap<i32, Vec<i32>> = HashMap::new();
        let Ok(entries) = fs::read_dir("/proc") else { return map };
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            if let Some(ppid) = read_ppid(pid) {
                map.entry(ppid).or_default().push(pid);
            }
        }
        map
    }

    fn read_ppid(pid: i32) -> Option<i32> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm 字段(第2列)可能含空格/括号,定位最后一个 ')' 之后再按空格切分才安全;
        // 之后第 1 个字段是 state,第 2 个字段是 ppid。
        let rparen = stat.rfind(')')?;
        let mut fields = stat[rparen + 1..].split_whitespace();
        fields.next()?; // state
        fields.next()?.parse().ok()
    }

    pub fn listen_ports_for_pids(pids: &[i32]) -> HashSet<u16> {
        let mut owned_inodes: HashSet<u64> = HashSet::new();
        for &pid in pids {
            let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
            for entry in entries.flatten() {
                if let Ok(target) = fs::read_link(entry.path()) {
                    if let Some(inode) = parse_socket_inode(&target) {
                        owned_inodes.insert(inode);
                    }
                }
            }
        }
        if owned_inodes.is_empty() {
            return HashSet::new();
        }
        let mut ports = HashSet::new();
        // v4 与 v6(如 vite/node 默认绑的 `::`)都要算,只报端口号不分地址族
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            collect_listen_ports(path, &owned_inodes, &mut ports);
        }
        ports
    }

    fn parse_socket_inode(target: &Path) -> Option<u64> {
        target.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
    }

    fn collect_listen_ports(path: &str, owned_inodes: &HashSet<u64>, ports: &mut HashSet<u16>) {
        let Ok(content) = fs::read_to_string(path) else { return };
        for line in content.lines().skip(1) {
            // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 {
                continue;
            }
            if fields[3] != "0A" {
                continue; // TCP_LISTEN
            }
            let Some((_, port_hex)) = fields[1].split_once(':') else { continue };
            let Ok(port) = u16::from_str_radix(port_hex, 16) else { continue };
            let Ok(inode) = fields[9].parse::<u64>() else { continue };
            if owned_inodes.contains(&inode) {
                ports.insert(port);
            }
        }
    }

    /// 仅供本模块单测使用:取得某 pid 的父 pid。cfg(test) 限定,避免正常构建里出现
    /// dead code 警告。
    #[cfg(test)]
    pub(crate) fn parent_pid(pid: i32) -> Option<i32> {
        read_ppid(pid)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use std::collections::HashSet;

    pub fn process_tree(root_pid: i32) -> Vec<i32> {
        vec![root_pid]
    }
    pub fn listen_ports_for_pids(_pids: &[i32]) -> HashSet<u16> {
        HashSet::new()
    }
    // 不提供 parent_pid:引用它的 tests 模块本就 cfg 限定 macos/linux,此平台上不编译。
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    /// 探测器能沿进程树往下找:测试进程自身绑定的监听端口,从「测试进程的父 pid」为根
    /// 出发扫描应当被发现(测试进程本身就是这棵树里的一个节点),这正是探测 PTY shell
    /// 子孙进程端口时依赖的同一条路径(root=shell pid,子孙=shell 起的 dev server)。
    #[test]
    fn finds_listening_port_rooted_at_parent_pid() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();

        let self_pid = std::process::id() as i32;
        let parent = imp::parent_pid(self_pid).expect("determine parent pid of test process");

        let found = listening_ports(parent);
        assert!(found.contains(&port), "expected port {port} reachable from parent pid {parent}, got {found:?}");
    }

    /// 安全边界:不是该进程树成员的端口绝不能被报出来。用一个真正无关的子进程(sleep)
    /// 做根——它没有也不可能拿到我们这边绑定的 socket fd(std TcpListener 默认 CLOEXEC)。
    #[test]
    fn does_not_find_port_of_unrelated_process() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();

        let mut child = std::process::Command::new("sleep").arg("2").spawn().expect("spawn sleep");
        let unrelated_pid = child.id() as i32;

        let found = listening_ports(unrelated_pid);
        assert!(!found.contains(&port), "port {port} leaked to unrelated pid {unrelated_pid}: {found:?}");

        let _ = child.kill();
        let _ = child.wait();
    }
}
