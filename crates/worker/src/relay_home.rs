//! 多 relay home 选择（plan 065）。
//!
//! 中心只下发静态 ws/wss 基址；本模块把 scheme 换成 http/https 并 GET `/healthz`，
//! 每节点连续采样三次取中位数。首次选最小 RTT；后续只有候选同时快至少 20ms、20%
//! 才切换，当前 home 不健康时则立即选任一健康节点。周期探测与拨号失败通知共用同一任务。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use coflux_protocol::wire::{self, daemon_to_server};
use futures_util::future::join_all;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{watch, Notify};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::http::Uri;

use crate::{send_d2s, WsOut};

const SAMPLES_PER_NODE: usize = 3;
const MIN_SUCCESSFUL_SAMPLES: usize = 2;
const SWITCH_MIN_MS: u128 = 20;
const SWITCH_MAX_RATIO_PERCENT: u128 = 80;
const MAX_HTTP_HEADER_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RelayNode {
    id: String,
    url: String,
}

#[derive(Clone)]
pub(crate) struct RelayHomeSelector {
    nodes: watch::Sender<Arc<Vec<RelayNode>>>,
    probe: Arc<Notify>,
}

impl RelayHomeSelector {
    pub(crate) fn spawn(
        to_server: tokio::sync::mpsc::Sender<WsOut>,
        interval: Duration,
        timeout: Duration,
    ) -> Self {
        let (nodes, receiver) = watch::channel(Arc::new(Vec::new()));
        let probe = Arc::new(Notify::new());
        tokio::spawn(run_selector(
            receiver,
            probe.clone(),
            to_server,
            interval,
            timeout,
        ));
        Self { nodes, probe }
    }

    pub(crate) fn set_nodes(&self, nodes: Vec<wire::relay_node_list::RelayNode>) {
        let mut seen = HashSet::new();
        let nodes = nodes
            .into_iter()
            .filter_map(|node| {
                if node.id.is_empty() || node.id.len() > 64 || !seen.insert(node.id.clone()) {
                    return None;
                }
                let normalized = RelayNode {
                    id: node.id,
                    url: node.url,
                };
                if ProbeTarget::from_base(&normalized.url).is_err() {
                    return None;
                }
                Some(normalized)
            })
            .collect::<Vec<_>>();
        eprintln!("[worker] relay 节点清单已更新 count={}", nodes.len());
        self.nodes.send_replace(Arc::new(nodes));
    }

    pub(crate) fn clear(&self) {
        self.nodes.send_replace(Arc::new(Vec::new()));
    }

    pub(crate) fn probe_now(&self) {
        self.probe.notify_one();
    }
}

#[derive(Clone, Debug)]
struct Measurement {
    node: RelayNode,
    rtt: Duration,
}

async fn run_selector(
    mut nodes_rx: watch::Receiver<Arc<Vec<RelayNode>>>,
    probe: Arc<Notify>,
    to_server: tokio::sync::mpsc::Sender<WsOut>,
    interval: Duration,
    timeout: Duration,
) {
    let connector = tls_connector();
    let mut home: Option<String> = None;

    loop {
        let nodes = Arc::clone(&nodes_rx.borrow());
        if nodes.is_empty() {
            home = None;
            tokio::select! {
                changed = nodes_rx.changed() => if changed.is_err() { return; },
                _ = probe.notified() => {},
            }
            continue;
        }

        // probe_now 只唤醒探测后的等待：探测期间到达的通知会保留一个 permit，
        // 本轮完成后立即触发下一轮；重复通知天然合并，不能取消正在进行的探测。
        let measurements = tokio::select! {
            changed = nodes_rx.changed() => {
                if changed.is_err() { return; }
                home = None;
                continue;
            },
            measurements = probe_nodes(nodes.as_ref(), &connector, timeout) => measurements,
        };

        for measurement in &measurements {
            eprintln!(
                "[worker] relay RTT id={} median_ms={}",
                measurement.node.id,
                measurement.rtt.as_millis()
            );
        }
        if let Some(selected) = choose_home(&measurements, home.as_deref()) {
            if home.as_deref() != Some(selected.node.id.as_str()) {
                home = Some(selected.node.id.clone());
                eprintln!("[worker] relay home changed id={}", selected.node.id);
                send_d2s(
                    &to_server,
                    daemon_to_server::Payload::RelayHome(wire::RelayHome {
                        relay_id: selected.node.id.clone(),
                    }),
                )
                .await;
            }
        } else {
            eprintln!("[worker] relay 探测无健康节点，本轮不上报 home");
        }

        tokio::select! {
            changed = nodes_rx.changed() => {
                if changed.is_err() { return; }
                home = None;
            },
            _ = probe.notified() => {},
            _ = tokio::time::sleep(interval) => {},
        }
    }
}

async fn probe_nodes(
    nodes: &[RelayNode],
    connector: &TlsConnector,
    timeout: Duration,
) -> Vec<Measurement> {
    join_all(nodes.iter().cloned().map(|node| {
        let connector = connector.clone();
        async move { probe_node(node, &connector, timeout).await }
    }))
    .await
    .into_iter()
    .flatten()
    .collect()
}

async fn probe_node(
    node: RelayNode,
    connector: &TlsConnector,
    timeout: Duration,
) -> Option<Measurement> {
    let target = ProbeTarget::from_base(&node.url).ok()?;
    let mut samples = Vec::with_capacity(SAMPLES_PER_NODE);
    for _ in 0..SAMPLES_PER_NODE {
        let started = Instant::now();
        if matches!(
            tokio::time::timeout(timeout, probe_once(&target, connector)).await,
            Ok(Ok(()))
        ) {
            samples.push(started.elapsed());
        }
    }
    if samples.len() < MIN_SUCCESSFUL_SAMPLES {
        return None;
    }
    samples.sort_unstable();
    Some(Measurement {
        node,
        rtt: samples[samples.len() / 2],
    })
}

fn choose_home<'a>(
    measurements: &'a [Measurement],
    current_home: Option<&str>,
) -> Option<&'a Measurement> {
    let best = measurements
        .iter()
        .min_by_key(|measurement| measurement.rtt)?;
    let Some(current_id) = current_home else {
        return Some(best);
    };
    let Some(current) = measurements
        .iter()
        .find(|measurement| measurement.node.id == current_id)
    else {
        return Some(best);
    };
    if best.node.id == current.node.id {
        return Some(current);
    }

    let best_ms = best.rtt.as_millis();
    let current_ms = current.rtt.as_millis();
    let significantly_faster = current_ms.saturating_sub(best_ms) >= SWITCH_MIN_MS
        && best_ms.saturating_mul(100) <= current_ms.saturating_mul(SWITCH_MAX_RATIO_PERCENT);
    if significantly_faster {
        Some(best)
    } else {
        Some(current)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ProbeTarget {
    tls: bool,
    host: String,
    authority: String,
    port: u16,
    path: String,
}

impl ProbeTarget {
    fn from_base(base: &str) -> Result<Self, String> {
        let uri: Uri = base.parse().map_err(|_| "relay URL 无效".to_string())?;
        let tls = match uri.scheme_str() {
            Some("ws") => false,
            Some("wss") => true,
            _ => return Err("relay URL scheme 必须是 ws/wss".into()),
        };
        let authority = uri
            .authority()
            .ok_or_else(|| "relay URL 缺少 authority".to_string())?;
        if authority.as_str().contains('@') || uri.query().is_some() {
            return Err("relay URL 不得带凭证或 query".into());
        }
        let bracketed_host = authority.host();
        let host = bracketed_host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(bracketed_host)
            .to_string();
        if host.is_empty() {
            return Err("relay URL host 为空".into());
        }
        let port = authority.port_u16().unwrap_or(if tls { 443 } else { 80 });
        let base_path = uri.path().trim_end_matches('/');
        let path = if base_path.is_empty() {
            "/healthz".to_string()
        } else {
            format!("{base_path}/healthz")
        };
        Ok(Self {
            tls,
            host,
            authority: authority.as_str().to_string(),
            port,
            path,
        })
    }
}

fn tls_connector() -> TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

trait ProbeIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProbeIo for T {}

async fn probe_once(target: &ProbeTarget, connector: &TlsConnector) -> Result<(), String> {
    let tcp = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|error| format!("relay TCP connect: {error}"))?;
    let mut stream: Box<dyn ProbeIo> = if target.tls {
        let server_name = ServerName::try_from(target.host.as_str())
            .map_err(|_| "relay TLS server name 无效".to_string())?
            .to_owned();
        Box::new(
            connector
                .connect(server_name, tcp)
                .await
                .map_err(|error| format!("relay TLS connect: {error}"))?,
        )
    } else {
        Box::new(tcp)
    };

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: text/plain\r\nConnection: close\r\n\r\n",
        target.path, target.authority
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("relay healthz write: {error}"))?;

    let mut response = Vec::with_capacity(512);
    let mut chunk = [0_u8; 512];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("relay healthz read: {error}"))?;
        if read == 0 {
            return Err("relay healthz 响应头不完整".into());
        }
        response.extend_from_slice(&chunk[..read]);
        if response.len() > MAX_HTTP_HEADER_BYTES {
            return Err("relay healthz 响应头过大".into());
        }
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let line_end = response
        .windows(2)
        .position(|window| window == b"\r\n")
        .ok_or_else(|| "relay healthz 状态行缺失".to_string())?;
    let status_line = std::str::from_utf8(&response[..line_end])
        .map_err(|_| "relay healthz 状态行不是 UTF-8".to_string())?;
    let mut parts = status_line.split_whitespace();
    let version = parts.next();
    let status = parts.next();
    if !matches!(version, Some("HTTP/1.0" | "HTTP/1.1")) || status != Some("200") {
        return Err(format!("relay healthz 非 200: {status_line}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn measurement(id: &str, millis: u64) -> Measurement {
        Measurement {
            node: RelayNode {
                id: id.into(),
                url: format!("ws://{id}"),
            },
            rtt: Duration::from_millis(millis),
        }
    }

    #[test]
    fn probe_url_derives_http_healthz_from_ws_base() {
        assert_eq!(
            ProbeTarget::from_base("wss://relay.example:8443/edge/").unwrap(),
            ProbeTarget {
                tls: true,
                host: "relay.example".into(),
                authority: "relay.example:8443".into(),
                port: 8443,
                path: "/edge/healthz".into(),
            }
        );
        assert_eq!(
            ProbeTarget::from_base("ws://127.0.0.1:8790").unwrap().path,
            "/healthz"
        );
    }

    #[test]
    fn home_switch_requires_absolute_and_relative_improvement() {
        let modest = vec![measurement("current", 50), measurement("candidate", 35)];
        assert_eq!(
            choose_home(&modest, Some("current")).unwrap().node.id,
            "current"
        );

        let significant = vec![measurement("current", 100), measurement("candidate", 75)];
        assert_eq!(
            choose_home(&significant, Some("current")).unwrap().node.id,
            "candidate"
        );

        let failed_current = vec![measurement("candidate", 200)];
        assert_eq!(
            choose_home(&failed_current, Some("current"))
                .unwrap()
                .node
                .id,
            "candidate"
        );
    }

    #[tokio::test]
    async fn plain_healthz_probe_requires_http_200() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n")
                .await
                .unwrap();
        });

        let target = ProbeTarget::from_base(&format!("ws://{addr}")).unwrap();
        probe_once(&target, &tls_connector()).await.unwrap();
    }
}
