//! TCP 隧道桥:把 server 下发的 proxy.open/proxy.close 落实为「daemon → 127.0.0.1:port
//! 的 TCP 连接」,字节经 ProxyData payload(按 connId 多路复用,套进 DaemonToServer 信封)
//! 与该 TCP 连接双向对拼。
//!
//! 生命周期完全绑定单次 server WS 连接:[TunnelSet] 由 `run_server_connection` 进入时
//! new、退出时 `close_all`,不跨重连恢复——浏览器侧的 TCP 早已断,恢复无意义
//! (见 plan 005 Decisions)。
//!
//! 并发结构:每条隧道的「TCP 读 → 转 ProxyData 帧发 server」是一个独立 spawn 的任务
//! (只单向读);「server 来的 ProxyData 帧 → 写 TCP」直接在调用方(main 的 WS 读循环)
//! 里对 `Arc<Mutex<OwnedWriteHalf>>` 加锁写入,不经额外 channel/task 中转。这是刻意的
//! 取舍:若走 channel 转给读任务侧的 select 消化,当 to_server_tx(读任务要用它上行发
//! 帧)背压打满、同时 main 的写路径又在等读任务腾出 channel 空位时,会与 main 自身要靠
//! select 排空 to_server_rx 才能给 to_server_tx 让路的逻辑相互等待,形成跨任务死锁。
//! 直接持锁写 TCP 没有这个环——最坏情况只是本地端口写得慢时暂时拖住 WS 读循环,是
//! plan 已接受的「V1 不做 per-connection 流控」代价的一部分,而不是新增风险。
//!
//! V1 数据面无 per-connection 流控:TCP 读一块(≤64KiB)发一帧；大流量隧道可让自己的
//! 上行任务等待中心队列，但 worker 不再据此暂停 supervisor PTY。local Device channel 与
//! checkpoint/relay 也使用独立出口，不受这条隧道反压。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use coflux_protocol::wire::{self, daemon_to_server};
use prost::Message as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc::Sender, oneshot};
use tokio::task::{AbortHandle, JoinHandle};

use crate::{try_send_d2s, WsOut};

const READ_CHUNK: usize = 64 * 1024;
/// connecting 与 active 共用同一个总量窗口。单 worker 同时代理 1024 条浏览器 TCP 已远高于
/// 正常开发负载，同时把每连接 task/socket/buffer 的常驻资源封顶。
const MAX_TUNNELS: usize = 1_024;

fn encode_d2s(payload: daemon_to_server::Payload) -> WsOut {
    wire::DaemonToServer {
        payload: Some(payload),
    }
    .encode_to_vec()
}

struct TunnelHandle {
    token: Arc<()>,
    writer: Arc<AsyncMutex<OwnedWriteHalf>>,
    writer_failed_tx: Option<oneshot::Sender<()>>,
    /// 只跑「TCP 读 → 转帧发 server」的单向泵；abort 即整条隧道的硬停止开关。
    reader_task: JoinHandle<()>,
}

struct ConnectingHandle {
    token: Arc<()>,
    /// connect task 在真正拨号前先停在 oneshot gate；句柄写入 reservation 后才放行。
    /// 因而 close/close_all 一旦摘掉 Connecting，就能可靠 abort，任务不会逃到 map 外堆积。
    connect_task: Option<AbortHandle>,
}

enum TunnelEntry {
    Connecting(ConnectingHandle),
    Active(TunnelHandle),
}

#[derive(Debug)]
enum ReserveError {
    Duplicate,
    Full,
}

impl ReserveError {
    fn message(&self, limit: usize) -> String {
        match self {
            Self::Duplicate => "重复的 proxy connId".into(),
            Self::Full => format!("预览隧道连接已达上限 {limit}"),
        }
    }
}

#[derive(Clone)]
pub struct TunnelSet {
    conns: Arc<Mutex<HashMap<String, TunnelEntry>>>,
    to_server_tx: Sender<WsOut>,
    max_conns: usize,
}

impl TunnelSet {
    pub fn new(to_server_tx: Sender<WsOut>) -> Self {
        Self::with_limit(to_server_tx, MAX_TUNNELS)
    }

    fn with_limit(to_server_tx: Sender<WsOut>, max_conns: usize) -> Self {
        assert!(max_conns > 0, "TunnelSet 容量必须非零");
        Self {
            conns: Arc::new(Mutex::new(HashMap::new())),
            to_server_tx,
            max_conns,
        }
    }

    /// 在 spawn/connect 之前原子预留 connId 与总量名额。token 让迟到的旧连接任务只能操作
    /// 自己的 reservation，close 后同 ID 重开也不会被旧 continuation 摘除。
    fn try_reserve(&self, conn_id: &str) -> Result<Arc<()>, ReserveError> {
        let mut conns = self.conns.lock().unwrap();
        if conns.contains_key(conn_id) {
            return Err(ReserveError::Duplicate);
        }
        if conns.len() >= self.max_conns {
            return Err(ReserveError::Full);
        }
        let token = Arc::new(());
        conns.insert(
            conn_id.to_string(),
            TunnelEntry::Connecting(ConnectingHandle {
                token: token.clone(),
                connect_task: None,
            }),
        );
        Ok(token)
    }

    fn attach_connect_task(&self, conn_id: &str, token: &Arc<()>, task: AbortHandle) -> bool {
        let mut conns = self.conns.lock().unwrap();
        let Some(TunnelEntry::Connecting(current)) = conns.get_mut(conn_id) else {
            return false;
        };
        if !Arc::ptr_eq(&current.token, token) {
            return false;
        }
        current.connect_task = Some(task);
        true
    }

    fn remove_connecting(
        conns: &Mutex<HashMap<String, TunnelEntry>>,
        conn_id: &str,
        token: &Arc<()>,
    ) -> bool {
        let mut conns = conns.lock().unwrap();
        let matches = matches!(
            conns.get(conn_id),
            Some(TunnelEntry::Connecting(current)) if Arc::ptr_eq(&current.token, token)
        );
        if matches {
            conns.remove(conn_id);
        }
        matches
    }

    /// 本地 TCP 自然关闭/写失败：先等有界出口 permit，再在同一把锁内校验 token、排
    /// proxy.closed、释放 connId。等待期间 entry 仍占名额，因而既可靠送达，也不会在 map 外
    /// 堆积通知任务；server 显式 close 抢先时会 abort reader，使等待立即取消。
    async fn finish_active(
        conns: &Mutex<HashMap<String, TunnelEntry>>,
        to_server_tx: &Sender<WsOut>,
        conn_id: &str,
        token: &Arc<()>,
    ) -> Option<TunnelHandle> {
        let permit = to_server_tx.reserve().await.ok();
        let mut conns = conns.lock().unwrap();
        let matches = matches!(
            conns.get(conn_id),
            Some(TunnelEntry::Active(handle)) if Arc::ptr_eq(&handle.token, token)
        );
        if !matches {
            return None;
        }
        if let Some(permit) = permit {
            permit.send(encode_d2s(daemon_to_server::Payload::ProxyClosed(
                wire::ProxyClosed {
                    conn_id: conn_id.to_string(),
                },
            )));
        }
        match conns.remove(conn_id) {
            Some(TunnelEntry::Active(handle)) => Some(handle),
            _ => unreachable!("active token check 与 remove 必须原子一致"),
        }
    }

    /// connect 失败同样先拿出口 permit，再在锁内校验 token、排回应、释放 reservation。
    /// close/reopen 若先发生，旧任务只会丢掉 permit，永远不能污染后来同 ID entry。
    async fn fail_connecting(
        conns: &Mutex<HashMap<String, TunnelEntry>>,
        to_server_tx: &Sender<WsOut>,
        conn_id: &str,
        token: &Arc<()>,
        error: String,
    ) {
        let permit = to_server_tx.reserve().await.ok();
        let mut conns = conns.lock().unwrap();
        let matches = matches!(
            conns.get(conn_id),
            Some(TunnelEntry::Connecting(current)) if Arc::ptr_eq(&current.token, token)
        );
        if !matches {
            return;
        }
        if let Some(permit) = permit {
            permit.send(encode_d2s(daemon_to_server::Payload::ProxyOpened(
                wire::ProxyOpened {
                    conn_id: conn_id.to_string(),
                    ok: false,
                    error: Some(error),
                },
            )));
        }
        conns.remove(conn_id);
    }

    /// reader 每块数据也先拿 permit、再在锁内按 token 入队。close 若先赢，旧 reader 的已读
    /// 数据会被丢弃；reader 若先赢，数据已明确排在随后 close/reopen 之前。
    async fn send_data_if_active(
        conns: &Mutex<HashMap<String, TunnelEntry>>,
        to_server_tx: &Sender<WsOut>,
        conn_id: &str,
        token: &Arc<()>,
        data: Vec<u8>,
    ) -> bool {
        let Ok(permit) = to_server_tx.reserve().await else {
            return false;
        };
        let conns = conns.lock().unwrap();
        let active = matches!(
            conns.get(conn_id),
            Some(TunnelEntry::Active(handle)) if Arc::ptr_eq(&handle.token, token)
        );
        if active {
            permit.send(encode_d2s(daemon_to_server::Payload::ProxyData(
                wire::ProxyData {
                    conn_id: conn_id.to_string(),
                    data,
                },
            )));
        }
        active
    }

    /// server 下发 proxy.open:异步连接本地端口(先 127.0.0.1 再 [::1]),回 proxy.opened;
    /// 成功则登记隧道、起读泵任务。不阻塞调用方(main 的 WS 事件循环)。
    pub fn open(&self, conn_id: String, port: u16) {
        let token = match self.try_reserve(&conn_id) {
            Ok(token) => token,
            Err(error) => {
                let message = error.message(self.max_conns);
                // route_authed 自己运行在同时负责排空 to_server_rx 的 select 分支里，不能 await
                // 同一个有界 channel；也不能为拒绝请求无限 spawn 等待任务。正常容量下立即回
                // ok:false，出口已满时则丢弃回执、保持 fail closed，由 server 自身超时收尾。
                let _ = try_send_d2s(
                    &self.to_server_tx,
                    daemon_to_server::Payload::ProxyOpened(wire::ProxyOpened {
                        conn_id,
                        ok: false,
                        error: Some(message),
                    }),
                );
                return;
            }
        };
        let conns = self.conns.clone();
        let to_server_tx = self.to_server_tx.clone();
        // 先 spawn 在 gate 上静止的任务，再把 AbortHandle 装进 Connecting，最后才允许拨号。
        // close 若在装句柄前抢先摘表，下面会立刻 abort，连接任务不会逃逸。
        let (connect_start_tx, connect_start_rx) = oneshot::channel();
        let connect_conn_id = conn_id.clone();
        let connect_token = token.clone();
        let connect_task = tokio::spawn(async move {
            let conn_id = connect_conn_id;
            let token = connect_token;
            if connect_start_rx.await.is_err() {
                return;
            }
            let stream = match connect_local(port).await {
                Ok(s) => s,
                Err(error) => {
                    Self::fail_connecting(&conns, &to_server_tx, &conn_id, &token, error).await;
                    return;
                }
            };
            let opened_permit = match to_server_tx.reserve().await {
                Ok(permit) => permit,
                Err(_) => {
                    Self::remove_connecting(&conns, &conn_id, &token);
                    return;
                }
            };

            let (mut rd, wr) = stream.into_split();
            let writer = Arc::new(AsyncMutex::new(wr));

            let reader_conn_id = conn_id.clone();
            let reader_token = token.clone();
            let reader_conns = conns.clone();
            let reader_to_server_tx = to_server_tx.clone();
            // 读泵必须等 Active 已原子入表且 proxy.opened 已排入 server 队列后再启动，避免
            // 极短连接先发 data/closed、后发 opened，也避免 spawn 后抢跑摘掉 Connecting。
            let (reader_start_tx, reader_start_rx) = oneshot::channel();
            let (writer_failed_tx, mut writer_failed_rx) = oneshot::channel();
            let reader_task = tokio::spawn(async move {
                if reader_start_rx.await.is_err() {
                    return;
                }
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    let read = tokio::select! {
                        _ = &mut writer_failed_rx => break,
                        read = rd.read(&mut buf) => read,
                    };
                    match read {
                        Ok(0) | Err(_) => break, // 本地 TCP 关闭/出错
                        Ok(n) => {
                            if !Self::send_data_if_active(
                                &reader_conns,
                                &reader_to_server_tx,
                                &reader_conn_id,
                                &reader_token,
                                buf[..n].to_vec(),
                            )
                            .await
                            {
                                break;
                            }
                        }
                    }
                }
                // 统一收尾:TCP 侧关闭/出错才走到这里——proxy.close 显式关闭走 abort，
                // 根本不会执行到这段代码，因此不会重复发 proxy.closed。
                let _ = Self::finish_active(
                    &reader_conns,
                    &reader_to_server_tx,
                    &reader_conn_id,
                    &reader_token,
                )
                .await;
            });

            let mut pending_handle = Some(TunnelHandle {
                token: token.clone(),
                writer,
                writer_failed_tx: Some(writer_failed_tx),
                reader_task,
            });
            let installed = {
                let mut current = conns.lock().unwrap();
                let still_reserved = matches!(
                    current.get(&conn_id),
                    Some(TunnelEntry::Connecting(current_token))
                        if Arc::ptr_eq(&current_token.token, &token)
                );
                if still_reserved {
                    // permit 已在锁外等待；这里同步入队 + 安装 Active，不给 close/reopen 留下
                    // 旧 opened 迟到入队的窗口，也不会在 map 外堆积等待出口的任务。
                    opened_permit.send(encode_d2s(daemon_to_server::Payload::ProxyOpened(
                        wire::ProxyOpened {
                            conn_id: conn_id.clone(),
                            ok: true,
                            error: None,
                        },
                    )));
                    current.insert(
                        conn_id.clone(),
                        TunnelEntry::Active(pending_handle.take().unwrap()),
                    );
                    true
                } else {
                    false
                }
            };
            if !installed {
                pending_handle.unwrap().reader_task.abort();
                return;
            }

            let _ = reader_start_tx.send(());
        });
        let connect_abort = connect_task.abort_handle();
        drop(connect_task); // 生命周期由 map 中的 AbortHandle 管；detach 不等于放弃取消能力。
        if self.attach_connect_task(&conn_id, &token, connect_abort.clone()) {
            let _ = connect_start_tx.send(());
        } else {
            connect_abort.abort();
        }
    }

    /// server 下发的 ProxyData payload（已从信封解出）:按 connId 写进对应 TCP 连接。
    /// 找不到 connId(本地连接可能已先一步自然关闭,server 还没收到 proxy.closed)静默丢弃。
    pub async fn feed(&self, conn_id: String, data: Vec<u8>) {
        let active = {
            self.conns
                .lock()
                .unwrap()
                .get(&conn_id)
                .and_then(|entry| match entry {
                    TunnelEntry::Active(handle) => {
                        Some((handle.writer.clone(), handle.token.clone()))
                    }
                    TunnelEntry::Connecting(_) => None,
                })
        };
        let Some((writer, token)) = active else {
            return;
        };
        let write_ok = {
            let mut w = writer.lock().await;
            w.write_all(&data).await.is_ok()
        };
        if !write_ok {
            // feed 跑在同时负责排空 to_server_rx 的主 select 分支里，不能亲自 await 出口。
            // 唤醒该连接已有且受上限约束的 reader task，由它可靠等待 permit、通知 closed、摘表。
            let writer_failed_tx = {
                let mut conns = self.conns.lock().unwrap();
                match conns.get_mut(&conn_id) {
                    Some(TunnelEntry::Active(handle)) if Arc::ptr_eq(&handle.token, &token) => {
                        handle.writer_failed_tx.take()
                    }
                    _ => None,
                }
            };
            if let Some(tx) = writer_failed_tx {
                let _ = tx.send(());
            }
        }
    }

    /// server 下发 proxy.close:关 TCP 并清理，不回 proxy.closed(server 已知道自己发起的关闭)。
    pub fn close(&self, conn_id: &str) {
        match self.conns.lock().unwrap().remove(conn_id) {
            Some(TunnelEntry::Connecting(handle)) => {
                if let Some(task) = handle.connect_task {
                    task.abort();
                }
            }
            Some(TunnelEntry::Active(handle)) => {
                handle.reader_task.abort(); // 读半部随 abort 释放；写半部随 handle drop 关闭
            }
            None => {}
        }
    }

    /// server WS 断线:全部隧道连接关闭、状态清零，不逐条回消息(server 已知道整条连接断了)。
    pub fn close_all(&self) {
        for (_, entry) in self.conns.lock().unwrap().drain() {
            match entry {
                TunnelEntry::Connecting(handle) => {
                    if let Some(task) = handle.connect_task {
                        task.abort();
                    }
                }
                TunnelEntry::Active(handle) => handle.reader_task.abort(),
            }
        }
    }
}

/// 先试 v4 回环,失败再试 v6 回环——v6-only 监听(如 vite/node 默认绑 `::`)也要能连通。
async fn connect_local(port: u16) -> Result<TcpStream, String> {
    match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => Ok(s),
        Err(e4) => match TcpStream::connect(("::1", port)).await {
            Ok(s) => Ok(s),
            Err(e6) => Err(format!(
                "127.0.0.1:{port} connect failed: {e4}; [::1]:{port} connect failed: {e6}"
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// 测试专用：解出信封 payload，None/解码失败直接 panic（测试里不该出现，出现即 bug）。
    fn decode(bytes: &[u8]) -> daemon_to_server::Payload {
        wire::DaemonToServer::decode(bytes)
            .expect("decode DaemonToServer")
            .payload
            .expect("payload present")
    }

    async fn next_opened(rx: &mut tokio::sync::mpsc::Receiver<WsOut>) -> wire::ProxyOpened {
        loop {
            let bytes = rx.recv().await.expect("channel open");
            if let daemon_to_server::Payload::ProxyOpened(opened) = decode(&bytes) {
                return opened;
            }
        }
    }

    #[test]
    fn connecting_reservations_share_limit_release_and_reject_stale_token() {
        let (to_server_tx, _to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(8);
        let tunnels = TunnelSet::with_limit(to_server_tx, 2);
        let first = tunnels.try_reserve("conn-a").unwrap();
        tunnels.try_reserve("conn-b").unwrap();
        assert!(matches!(
            tunnels.try_reserve("conn-c"),
            Err(ReserveError::Full)
        ));
        assert!(matches!(
            tunnels.try_reserve("conn-a"),
            Err(ReserveError::Duplicate)
        ));
        assert_eq!(tunnels.conns.lock().unwrap().len(), 2);

        tunnels.close("conn-a");
        let replacement = tunnels.try_reserve("conn-a").unwrap();
        assert!(
            !TunnelSet::remove_connecting(&tunnels.conns, "conn-a", &first),
            "旧 connect continuation 不能摘掉同 ID 的新 reservation"
        );
        let current = tunnels.conns.lock().unwrap();
        assert!(matches!(
            current.get("conn-a"),
            Some(TunnelEntry::Connecting(handle)) if Arc::ptr_eq(&handle.token, &replacement)
        ));
        drop(current);
        tunnels.close_all();
        assert!(tunnels.conns.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_reservations_cannot_cross_hard_limit() {
        let (to_server_tx, _to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(8);
        let tunnels = TunnelSet::with_limit(to_server_tx, 8);
        let barrier = Arc::new(std::sync::Barrier::new(33));
        let mut threads = Vec::new();
        for index in 0..32 {
            let tunnels = tunnels.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                tunnels.try_reserve(&format!("conn-{index}")).is_ok()
            }));
        }
        barrier.wait();
        let accepted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|accepted| *accepted)
            .count();
        assert_eq!(accepted, 8);
        assert_eq!(tunnels.conns.lock().unwrap().len(), 8);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn close_connecting_aborts_dial_before_reusing_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(8);
        let tunnels = TunnelSet::with_limit(to_server_tx, 1);

        // current-thread runtime 在本测试首次 await 前不会 poll spawn 出来的 connect task；因此
        // close 必须能靠 reservation 里的 AbortHandle 把旧拨号取消，再把名额立即给新连接。
        tunnels.open("conn-old".into(), port);
        tunnels.close("conn-old");
        assert!(tunnels.conns.lock().unwrap().is_empty());
        tunnels.open("conn-current".into(), port);

        let opened = next_opened(&mut to_server_rx).await;
        assert!(opened.ok);
        assert_eq!(opened.conn_id, "conn-current");
        let (current_peer, _) =
            tokio::time::timeout(std::time::Duration::from_millis(500), listener.accept())
                .await
                .expect("新连接应拨到 listener")
                .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "被 close 的旧 Connecting 不得在 map 外继续拨号"
        );

        tunnels.close("conn-current");
        drop(current_peer);
    }

    #[tokio::test]
    async fn natural_close_waits_for_outbound_permit_before_releasing_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(1);
        let tunnels = TunnelSet::with_limit(to_server_tx.clone(), 1);

        tunnels.open("conn-close".into(), port);
        let opened = next_opened(&mut to_server_rx).await;
        assert!(opened.ok);
        let (peer, _) = listener.accept().await.unwrap();

        // 占满出口后让本地 TCP EOF。reader 应保留 Active entry 等 permit，不能先摘表再
        // 丢失 proxy.closed，否则 server 会永久保留浏览器 socket。
        to_server_tx.send(vec![0]).await.unwrap();
        drop(peer);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(tunnels.conns.lock().unwrap().len(), 1);

        assert_eq!(to_server_rx.recv().await.unwrap(), vec![0]);
        let closed =
            tokio::time::timeout(std::time::Duration::from_millis(500), to_server_rx.recv())
                .await
                .expect("出口腾出后应可靠发送 proxy.closed")
                .unwrap();
        let daemon_to_server::Payload::ProxyClosed(closed) = decode(&closed) else {
            panic!("expected ProxyClosed payload")
        };
        assert_eq!(closed.conn_id, "conn-close");
        assert!(tunnels.conns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn blocked_old_reader_cannot_send_data_into_reopened_same_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(1);
        let tunnels = TunnelSet::with_limit(to_server_tx.clone(), 1);

        tunnels.open("same-id".into(), port);
        assert!(next_opened(&mut to_server_rx).await.ok);
        let (mut old_peer, _) = listener.accept().await.unwrap();
        to_server_tx.send(vec![0]).await.unwrap();
        old_peer.write_all(b"old-data").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        // 旧 reader 此刻卡在 reserve；close 后同 ID 重开。即使旧 reserve continuation 随后
        // 被唤醒，也必须因 token 不匹配而丢掉 old-data。
        tunnels.close("same-id");
        tunnels.open("same-id".into(), port);
        let (current_peer, _) = listener.accept().await.unwrap();
        assert_eq!(to_server_rx.recv().await.unwrap(), vec![0]);

        let current_opened_bytes =
            tokio::time::timeout(std::time::Duration::from_millis(500), to_server_rx.recv())
                .await
                .expect("新连接应在出口腾出后 opened")
                .unwrap();
        let daemon_to_server::Payload::ProxyOpened(current_opened) = decode(&current_opened_bytes)
        else {
            panic!("旧 reader 数据不得抢在新连接 opened 前入队")
        };
        assert!(current_opened.ok);
        assert_eq!(current_opened.conn_id, "same-id");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), to_server_rx.recv())
                .await
                .is_err(),
            "旧 reader 数据不得在同 ID 新连接 opened 后出现"
        );

        tunnels.close("same-id");
        drop(old_peer);
        drop(current_peer);
    }

    #[tokio::test]
    async fn active_limit_and_duplicate_fail_closed_then_close_releases_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    loop {
                        let Ok(length) = socket.read(&mut buf).await else {
                            break;
                        };
                        if length == 0 || socket.write_all(&buf[..length]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(32);
        let tunnels = TunnelSet::with_limit(to_server_tx, 1);
        tunnels.open("conn-active".into(), port);
        let opened = next_opened(&mut to_server_rx).await;
        assert!(opened.ok);

        tunnels.open("conn-active".into(), port);
        let duplicate = next_opened(&mut to_server_rx).await;
        assert!(!duplicate.ok);
        assert!(duplicate.error.unwrap().contains("重复"));
        assert_eq!(tunnels.conns.lock().unwrap().len(), 1);

        tunnels.open("conn-full".into(), port);
        let full = next_opened(&mut to_server_rx).await;
        assert!(!full.ok);
        assert!(full.error.unwrap().contains("上限"));
        assert_eq!(tunnels.conns.lock().unwrap().len(), 1);

        tunnels
            .feed("conn-active".into(), b"still-alive".to_vec())
            .await;
        let echoed = loop {
            let bytes = to_server_rx.recv().await.unwrap();
            if let daemon_to_server::Payload::ProxyData(data) = decode(&bytes) {
                break data;
            }
        };
        assert_eq!(echoed.conn_id, "conn-active");
        assert_eq!(echoed.data, b"still-alive");

        tunnels.close("conn-active");
        assert!(tunnels.conns.lock().unwrap().is_empty());
        tunnels.open("conn-next".into(), port);
        let reopened = next_opened(&mut to_server_rx).await;
        assert!(reopened.ok);
        assert_eq!(reopened.conn_id, "conn-next");
        tunnels.close("conn-next");
    }

    /// connId 多路复用下的双向字节透传 + 关闭传播:起两个本地 TcpListener 模拟两个
    /// "dev server",各 open 一条隧道，交替喂两边的 ProxyData 帧，断言互不干扰；
    /// 其中一条本地连接主动关闭后应该收到该 connId 的 proxy.closed，另一条不受影响。
    #[tokio::test]
    async fn multiplexed_roundtrip_and_close_propagation() {
        let listener_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_a = listener_a.local_addr().unwrap().port();
        let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_b = listener_b.local_addr().unwrap().port();

        // 模拟"本地服务":accept 一条连接，把收到的字节原样回显（除非收到 b"close-me"，
        // 则主动断开——用来触发 TCP 侧关闭 -> proxy.closed 的路径）。
        let echo = |listener: TcpListener| {
            tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if &buf[..n] == b"close-me" {
                                break;
                            }
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            })
        };
        echo(listener_a);
        echo(listener_b);

        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(64);
        let tunnels = TunnelSet::new(to_server_tx);

        tunnels.open("conn-a".into(), port_a);
        tunnels.open("conn-b".into(), port_b);

        // 期望先各收到一条 proxy.opened{ok:true}（顺序不保证，两条都要出现）。
        let mut seen_opened: Vec<String> = Vec::new();
        while seen_opened.len() < 2 {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if let daemon_to_server::Payload::ProxyOpened(m) = decode(&bytes) {
                assert!(m.ok);
                seen_opened.push(m.conn_id);
            }
        }
        seen_opened.sort();
        assert_eq!(seen_opened, vec!["conn-a", "conn-b"]);

        // 喂两条连接的数据（交替），驱动 daemon -> 本地端口 -> echo -> daemon -> server 的完整闭环。
        tunnels.feed("conn-a".into(), b"hello-a".to_vec()).await;
        tunnels.feed("conn-b".into(), b"hello-b".to_vec()).await;

        let mut got: HashMap<String, Vec<u8>> = HashMap::new();
        while got.len() < 2 {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if let daemon_to_server::Payload::ProxyData(m) = decode(&bytes) {
                got.insert(m.conn_id, m.data);
            }
        }
        assert_eq!(got.get("conn-a").unwrap(), b"hello-a");
        assert_eq!(got.get("conn-b").unwrap(), b"hello-b");

        // conn-a 的本地端触发关闭：echo 收到 "close-me" 后主动断开 -> daemon 侧读泵探测到
        // EOF -> 应该发一条 conn-a 的 proxy.closed，且不影响 conn-b。
        tunnels.feed("conn-a".into(), b"close-me".to_vec()).await;

        let closed = loop {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if let daemon_to_server::Payload::ProxyClosed(m) = decode(&bytes) {
                break m.conn_id;
            }
        };
        assert_eq!(closed, "conn-a");

        // conn-b 依旧健在：喂一段数据仍能收到回显。
        tunnels.feed("conn-b".into(), b"still-alive".to_vec()).await;
        let echoed = loop {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if let daemon_to_server::Payload::ProxyData(m) = decode(&bytes) {
                if m.conn_id == "conn-b" {
                    break m.data;
                }
            }
        };
        assert_eq!(echoed, b"still-alive");
    }

    /// server 显式 proxy.close:关 TCP、从 map 摘除，且不应该再产生该 connId 的 proxy.closed
    /// 回执(区分于 TCP 侧自然关闭的路径)。
    #[tokio::test]
    async fn explicit_close_does_not_emit_proxy_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 64];
            // park 住，直到 daemon 侧主动断开（不主动写数据，避免污染 to_server_tx）
            let _ = sock.read(&mut buf).await;
        });

        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(64);
        let tunnels = TunnelSet::new(to_server_tx);
        tunnels.open("conn-x".into(), port);

        // 等 proxy.opened
        loop {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if matches!(decode(&bytes), daemon_to_server::Payload::ProxyOpened(_)) {
                break;
            }
        }

        tunnels.close("conn-x");

        // 明确不应该在随后短窗口内出现 conn-x 的 proxy.closed。
        let outcome =
            tokio::time::timeout(std::time::Duration::from_millis(200), to_server_rx.recv()).await;
        assert!(
            outcome.is_err(),
            "unexpected message after explicit close: {outcome:?}"
        );
    }

    /// WS 断线场景:close_all 应该把所有隧道任务硬停，且不再往 to_server_tx 里写任何后续消息。
    #[tokio::test]
    async fn close_all_aborts_every_tunnel() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 64];
            let _ = sock.read(&mut buf).await;
        });

        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(64);
        let tunnels = TunnelSet::new(to_server_tx);
        tunnels.open("conn-y".into(), port);

        loop {
            let bytes = to_server_rx.recv().await.expect("channel open");
            if matches!(decode(&bytes), daemon_to_server::Payload::ProxyOpened(_)) {
                break;
            }
        }

        tunnels.close_all();
        assert_eq!(tunnels.conns.lock().unwrap().len(), 0);

        let outcome =
            tokio::time::timeout(std::time::Duration::from_millis(200), to_server_rx.recv()).await;
        assert!(
            outcome.is_err(),
            "unexpected message after close_all: {outcome:?}"
        );
    }

    /// 连接失败(端口无人监听)时回 proxy.opened{ok:false},且不留下任何隧道状态。
    #[tokio::test]
    async fn connect_failure_reports_ok_false() {
        // 找一个大概率没人监听的端口:先 bind 拿到一个空闲端口号,立刻释放再用它连接。
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let (to_server_tx, mut to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(64);
        let tunnels = TunnelSet::new(to_server_tx);
        tunnels.open("conn-z".into(), port);

        let bytes = to_server_rx.recv().await.expect("channel open");
        let daemon_to_server::Payload::ProxyOpened(m) = decode(&bytes) else {
            panic!("expected ProxyOpened payload")
        };
        assert!(!m.ok);
        assert!(m.error.is_some());

        assert_eq!(tunnels.conns.lock().unwrap().len(), 0);
    }
}
