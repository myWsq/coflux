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
//! V1 数据面无流控:TCP 读一块(≤64KiB)发一帧,不做背压;大流量隧道会顶高全局
//! `to_server_tx` 水位、触发 PtyPause(见 main.rs 背压任务与 plan Landmines)。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use coflux_protocol::wire::{self, daemon_to_server};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::sync::mpsc::Sender;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::{send_d2s, WsOut};

const READ_CHUNK: usize = 64 * 1024;

struct TunnelHandle {
    writer: Arc<AsyncMutex<OwnedWriteHalf>>,
    /// 只跑「TCP 读 → 转帧发 server」的单向泵；abort 即整条隧道的硬停止开关。
    reader_task: JoinHandle<()>,
}

#[derive(Clone)]
pub struct TunnelSet {
    conns: Arc<Mutex<HashMap<String, TunnelHandle>>>,
    to_server_tx: Sender<WsOut>,
}

impl TunnelSet {
    pub fn new(to_server_tx: Sender<WsOut>) -> Self {
        Self { conns: Arc::new(Mutex::new(HashMap::new())), to_server_tx }
    }

    /// server 下发 proxy.open:异步连接本地端口(先 127.0.0.1 再 [::1]),回 proxy.opened;
    /// 成功则登记隧道、起读泵任务。不阻塞调用方(main 的 WS 事件循环)。
    pub fn open(&self, conn_id: String, port: u16) {
        let conns = self.conns.clone();
        let to_server_tx = self.to_server_tx.clone();
        tokio::spawn(async move {
            let stream = match connect_local(port).await {
                Ok(s) => s,
                Err(error) => {
                    send_d2s(&to_server_tx, daemon_to_server::Payload::ProxyOpened(wire::ProxyOpened { conn_id, ok: false, error: Some(error) })).await;
                    return;
                }
            };
            send_d2s(&to_server_tx, daemon_to_server::Payload::ProxyOpened(wire::ProxyOpened { conn_id: conn_id.clone(), ok: true, error: None })).await;

            let (mut rd, wr) = stream.into_split();
            let writer = Arc::new(AsyncMutex::new(wr));

            let reader_conn_id = conn_id.clone();
            let reader_conns = conns.clone();
            let reader_to_server_tx = to_server_tx.clone();
            let reader_task = tokio::spawn(async move {
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) | Err(_) => break, // 本地 TCP 关闭/出错
                        Ok(n) => {
                            let payload = daemon_to_server::Payload::ProxyData(wire::ProxyData { conn_id: reader_conn_id.clone(), data: buf[..n].to_vec() });
                            send_d2s(&reader_to_server_tx, payload).await;
                        }
                    }
                }
                // 统一收尾:TCP 侧关闭/出错才走到这里——proxy.close 显式关闭走 abort，
                // 根本不会执行到这段代码，因此不会重复发 proxy.closed。
                reader_conns.lock().unwrap().remove(&reader_conn_id);
                send_d2s(&reader_to_server_tx, daemon_to_server::Payload::ProxyClosed(wire::ProxyClosed { conn_id: reader_conn_id })).await;
            });

            conns.lock().unwrap().insert(conn_id, TunnelHandle { writer, reader_task });
        });
    }

    /// server 下发的 ProxyData payload（已从信封解出）:按 connId 写进对应 TCP 连接。
    /// 找不到 connId(本地连接可能已先一步自然关闭,server 还没收到 proxy.closed)静默丢弃。
    pub async fn feed(&self, conn_id: String, data: Vec<u8>) {
        let writer = { self.conns.lock().unwrap().get(&conn_id).map(|h| h.writer.clone()) };
        let Some(writer) = writer else { return };
        let write_ok = {
            let mut w = writer.lock().await;
            w.write_all(&data).await.is_ok()
        };
        if !write_ok {
            // 本地写失败:等同「TCP 侧关闭/出错」——摘除、停读泵、通知 server。
            if let Some(handle) = self.conns.lock().unwrap().remove(&conn_id) {
                handle.reader_task.abort();
            }
            send_d2s(&self.to_server_tx, daemon_to_server::Payload::ProxyClosed(wire::ProxyClosed { conn_id })).await;
        }
    }

    /// server 下发 proxy.close:关 TCP 并清理，不回 proxy.closed(server 已知道自己发起的关闭)。
    pub fn close(&self, conn_id: &str) {
        if let Some(handle) = self.conns.lock().unwrap().remove(conn_id) {
            handle.reader_task.abort(); // 读半部随 abort 释放；写半部随 handle drop 关闭
        }
    }

    /// server WS 断线:全部隧道连接关闭、状态清零，不逐条回消息(server 已知道整条连接断了)。
    pub fn close_all(&self) {
        for (_, handle) in self.conns.lock().unwrap().drain() {
            handle.reader_task.abort();
        }
    }
}

/// 先试 v4 回环,失败再试 v6 回环——v6-only 监听(如 vite/node 默认绑 `::`)也要能连通。
async fn connect_local(port: u16) -> Result<TcpStream, String> {
    match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => Ok(s),
        Err(e4) => match TcpStream::connect(("::1", port)).await {
            Ok(s) => Ok(s),
            Err(e6) => Err(format!("127.0.0.1:{port} connect failed: {e4}; [::1]:{port} connect failed: {e6}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as _;
    use tokio::net::TcpListener;

    /// 测试专用：解出信封 payload，None/解码失败直接 panic（测试里不该出现，出现即 bug）。
    fn decode(bytes: &[u8]) -> daemon_to_server::Payload {
        wire::DaemonToServer::decode(bytes).expect("decode DaemonToServer").payload.expect("payload present")
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
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(200), to_server_rx.recv()).await;
        assert!(outcome.is_err(), "unexpected message after explicit close: {outcome:?}");
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

        let outcome = tokio::time::timeout(std::time::Duration::from_millis(200), to_server_rx.recv()).await;
        assert!(outcome.is_err(), "unexpected message after close_all: {outcome:?}");
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
        let daemon_to_server::Payload::ProxyOpened(m) = decode(&bytes) else { panic!("expected ProxyOpened payload") };
        assert!(!m.ok);
        assert!(m.error.is_some());

        assert_eq!(tunnels.conns.lock().unwrap().len(), 0);
    }
}
