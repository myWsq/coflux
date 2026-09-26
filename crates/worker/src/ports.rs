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

/// root_pid 自身 + 全部子孙 pid。agent 探测（agents.rs，plan 073）与端口探测共用同一套
/// 平台实现，避免第二份 /proc / libproc 遍历代码。
pub(crate) fn process_tree(root_pid: i32) -> Vec<i32> {
    imp::process_tree(root_pid)
}

/// The uid owning the caller's end of a loopback TCP connection to the gateway (plan
/// 20260926-agent-endpoint-hardening). `peer` is the address the gateway sees for the caller,
/// `gateway` the accepted stream's local address. `None` when no matching ESTABLISHED row is
/// found; the table is re-read a couple of times first, because `seq_file` can skip rows while
/// the kernel's table changes under the reader.
#[cfg(target_os = "linux")]
pub fn tcp_caller_uid(peer: std::net::SocketAddr, gateway: std::net::SocketAddr) -> Option<u32> {
    for _ in 0..3 {
        let tables = imp::read_tcp_tables();
        if let Some(uid) = caller_uid_in_tables(tables.iter().map(String::as_str), peer, gateway) {
            return Some(uid);
        }
    }
    None
}

/// Rows of a `/proc/net/tcp{,6}` table, header skipped, split into fields:
/// `sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …`.
#[cfg(any(target_os = "linux", test))]
fn tcp_table_rows(content: &str) -> impl Iterator<Item = Vec<&str>> {
    content
        .lines()
        .skip(1)
        .map(|line| line.split_whitespace().collect::<Vec<&str>>())
        .filter(|fields| fields.len() >= 10)
}

/// `ADDR:PORT` as the kernel prints it. The address is 1 (v4) or 4 (v6) 32-bit words, each
/// printed with `%08X` from its in-memory value, i.e. in the machine's native byte order; the
/// port is printed in host order.
#[cfg(any(target_os = "linux", test))]
fn parse_proc_socket_addr(field: &str) -> Option<std::net::SocketAddr> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    let (address, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let word = |index: usize| -> Option<[u8; 4]> {
        let hex = address.get(index * 8..index * 8 + 8)?;
        Some(u32::from_str_radix(hex, 16).ok()?.to_ne_bytes())
    };
    let ip = match address.len() {
        8 => IpAddr::V4(Ipv4Addr::from(word(0)?)),
        32 => {
            let mut bytes = [0u8; 16];
            for index in 0..4 {
                bytes[index * 4..index * 4 + 4].copy_from_slice(&word(index)?);
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// Same endpoint across address families: an AF_INET6 client talking to the v4 listener shows up
/// in `tcp6` with IPv4-mapped addresses, while the gateway sees plain IPv4.
#[cfg(any(target_os = "linux", test))]
fn same_endpoint(a: std::net::SocketAddr, b: std::net::SocketAddr) -> bool {
    use std::net::IpAddr;
    let canonical = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => v4.to_ipv6_mapped(),
        IpAddr::V6(v6) => v6,
    };
    a.port() == b.port() && canonical(a.ip()) == canonical(b.ip())
}

/// The caller's row is the one seen from the caller's side: `local_address` = the peer address
/// the gateway sees, `rem_address` = the gateway address, and state ESTABLISHED (`01`). Any other
/// state is refused: a TIME_WAIT or orphaned row prints uid 0, which a root worker would accept.
#[cfg(any(target_os = "linux", test))]
fn caller_uid_in_tables<'a>(
    tables: impl IntoIterator<Item = &'a str>,
    peer: std::net::SocketAddr,
    gateway: std::net::SocketAddr,
) -> Option<u32> {
    for content in tables {
        for fields in tcp_table_rows(content) {
            if fields[3] != "01" {
                continue;
            }
            let (Some(local), Some(remote)) = (
                parse_proc_socket_addr(fields[1]),
                parse_proc_socket_addr(fields[2]),
            ) else {
                continue;
            };
            if same_endpoint(local, peer) && same_endpoint(remote, gateway) {
                return fields[7].parse().ok();
            }
        }
    }
    None
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
            let children =
                pids_by_type(ProcFilter::ByParentProcess { ppid: pid as u32 }).unwrap_or_default();
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
            let Ok(info) = pidinfo::<BSDInfo>(pid, 0) else {
                continue;
            };
            let Ok(fds) = listpidinfo::<ListFDs>(pid, info.pbi_nfiles as usize) else {
                continue;
            };
            for fd in fds {
                if !matches!(ProcFDType::from(fd.proc_fdtype), ProcFDType::Socket) {
                    continue;
                }
                let Ok(sock) = pidfdinfo::<SocketFDInfo>(pid, fd.proc_fd) else {
                    continue;
                };
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
        pidinfo::<BSDInfo>(pid, 0)
            .ok()
            .map(|info| info.pbi_ppid as i32)
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
                None => fallback
                    .get_or_insert_with(build_ppid_map)
                    .get(&pid)
                    .cloned()
                    .unwrap_or_default(),
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
                out.extend(
                    content
                        .split_whitespace()
                        .filter_map(|tok| tok.parse::<i32>().ok()),
                );
            }
        }
        any_children_file.then_some(out)
    }

    /// 兜底:全量遍历 `/proc/*/stat` 建 pid -> children 反向表(一次扫描覆盖全部 pid)。
    fn build_ppid_map() -> HashMap<i32, Vec<i32>> {
        let mut map: HashMap<i32, Vec<i32>> = HashMap::new();
        let Ok(entries) = fs::read_dir("/proc") else {
            return map;
        };
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<i32>().ok())
            else {
                continue;
            };
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
            let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
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
        for content in read_tcp_tables() {
            collect_listen_ports(&content, &owned_inodes, &mut ports);
        }
        ports
    }

    /// The contents of `/proc/net/tcp` and `/proc/net/tcp6`, whichever are readable. Shared by
    /// the port probe and the gateway's caller-uid lookup ([super::tcp_caller_uid]).
    pub fn read_tcp_tables() -> Vec<String> {
        ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|path| fs::read_to_string(path).ok())
            .collect()
    }

    fn parse_socket_inode(target: &Path) -> Option<u64> {
        target
            .to_str()?
            .strip_prefix("socket:[")?
            .strip_suffix(']')?
            .parse()
            .ok()
    }

    fn collect_listen_ports(content: &str, owned_inodes: &HashSet<u64>, ports: &mut HashSet<u16>) {
        for fields in super::tcp_table_rows(content) {
            if fields[3] != "0A" {
                continue; // TCP_LISTEN
            }
            let Some((_, port_hex)) = fields[1].split_once(':') else {
                continue;
            };
            let Ok(port) = u16::from_str_radix(port_hex, 16) else {
                continue;
            };
            let Ok(inode) = fields[9].parse::<u64>() else {
                continue;
            };
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
        assert!(
            found.contains(&port),
            "expected port {port} reachable from parent pid {parent}, got {found:?}"
        );
    }

    /// 安全边界:不是该进程树成员的端口绝不能被报出来。用一个真正无关的子进程(sleep)
    /// 做根——它没有也不可能拿到我们这边绑定的 socket fd(std TcpListener 默认 CLOEXEC)。
    ///
    /// 先 spawn 再 bind,顺序是必须的:CLOEXEC 只在 exec 那一刻生效,fork 之后到 exec 之前
    /// 子进程的 /proc/<pid>/fd 仍是父进程 fd 表的副本。若先 bind 再 spawn,慢机器上就可能
    /// 在那个窗口里读到继承来的 listener fd 而误判泄漏(CI 上实测 flaky)。
    #[test]
    fn does_not_find_port_of_unrelated_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("2")
            .spawn()
            .expect("spawn sleep");
        let unrelated_pid = child.id() as i32;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();

        let found = listening_ports(unrelated_pid);
        assert!(
            !found.contains(&port),
            "port {port} leaked to unrelated pid {unrelated_pid}: {found:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The gateway's caller-uid lookup against fixture `/proc/net/tcp{,6}` content. The fixtures are
/// what a little-endian kernel prints (x86_64, aarch64: every target this ships on).
#[cfg(all(test, target_endian = "little"))]
mod tcp_table_tests {
    use super::*;
    use std::net::SocketAddr;

    const HEADER: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

    fn row(local: &str, remote: &str, state: &str, uid: u32) -> String {
        format!("   1: {local} {remote} {state} 00000000:00000000 00:00000000 00000000  {uid}        0 4242 1 0000000000000000 20 4 30 10 -1")
    }

    fn table(rows: &[String]) -> String {
        std::iter::once(HEADER.to_string())
            .chain(rows.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn addr(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    // 127.0.0.1 / ::1 / ::ffff:127.0.0.1 as printed on little-endian; gateway port 8788 = 0x2254.
    const V4_LOOPBACK: &str = "0100007F";
    const V6_LOOPBACK: &str = "00000000000000000000000001000000";
    const V4_MAPPED_LOOPBACK: &str = "0000000000000000FFFF00000100007F";

    fn fixtures() -> (String, String) {
        let tcp = table(&[
            // The listener and the worker's own accepted end: never the caller's row.
            row(&format!("{V4_LOOPBACK}:2254"), "00000000:0000", "0A", 1000),
            row(&format!("{V4_LOOPBACK}:2254"), &format!("{V4_LOOPBACK}:D431"), "01", 1000),
            // The caller's end of a v4 connection (port 54321).
            row(&format!("{V4_LOOPBACK}:D431"), &format!("{V4_LOOPBACK}:2254"), "01", 1001),
            // A TIME_WAIT leftover (port 42000) prints uid 0.
            row(&format!("{V4_LOOPBACK}:A410"), &format!("{V4_LOOPBACK}:2254"), "06", 0),
        ]);
        let tcp6 = table(&[
            // The caller's end of a ::1 connection (port 40000).
            row(&format!("{V6_LOOPBACK}:9C40"), &format!("{V6_LOOPBACK}:2254"), "01", 1002),
            // An AF_INET6 client on the v4 listener (port 41000): IPv4-mapped in tcp6.
            row(&format!("{V4_MAPPED_LOOPBACK}:A028"), &format!("{V4_MAPPED_LOOPBACK}:2254"), "01", 1003),
        ]);
        (tcp, tcp6)
    }

    fn lookup(peer: &str, gateway: &str) -> Option<u32> {
        let (tcp, tcp6) = fixtures();
        caller_uid_in_tables([tcp.as_str(), tcp6.as_str()], addr(peer), addr(gateway))
    }

    #[test]
    fn finds_the_callers_row_for_v4_v6_and_mapped_clients() {
        assert_eq!(lookup("127.0.0.1:54321", "127.0.0.1:8788"), Some(1001));
        assert_eq!(lookup("[::1]:40000", "[::1]:8788"), Some(1002));
        assert_eq!(lookup("127.0.0.1:41000", "127.0.0.1:8788"), Some(1003));
    }

    #[test]
    fn refuses_time_wait_and_missing_rows() {
        // TIME_WAIT with uid 0 must not be taken for the caller.
        assert_eq!(lookup("127.0.0.1:42000", "127.0.0.1:8788"), None);
        // No row at all.
        assert_eq!(lookup("127.0.0.1:43000", "127.0.0.1:8788"), None);
        // The right peer port against the wrong gateway port is not a match either.
        assert_eq!(lookup("127.0.0.1:54321", "127.0.0.1:8789"), None);
        // Nor is the v4 row taken for a ::1 peer on the same port.
        assert_eq!(lookup("[::1]:54321", "[::1]:8788"), None);
    }

    #[test]
    fn parses_kernel_addresses() {
        assert_eq!(parse_proc_socket_addr("0100007F:2254"), Some(addr("127.0.0.1:8788")));
        assert_eq!(parse_proc_socket_addr(&format!("{V6_LOOPBACK}:2254")), Some(addr("[::1]:8788")));
        assert_eq!(
            parse_proc_socket_addr(&format!("{V4_MAPPED_LOOPBACK}:2254")),
            Some(addr("[::ffff:127.0.0.1]:8788"))
        );
        assert_eq!(parse_proc_socket_addr("garbage"), None);
        assert_eq!(parse_proc_socket_addr("0100007:2254"), None);
    }
}
