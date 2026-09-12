//! Candidate remote channels. Central authority is checked before DeviceRuntime.

use crate::device::DeviceRuntime;
use crate::tailcat_auth::{self, Grants};
use crate::tailcat_ipc::{Frame, Helper};
use coflux_protocol::wire::{self, daemon_to_server};
use prost::Message;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Serving {
    helper: Arc<Helper>,
    daemon: String,
    public_key: String,
    epoch: u64,
    health_now: tokio::sync::Notify,
    retiring: AtomicBool,
    grants: Mutex<Option<Grants>>,
    channels: Mutex<HashMap<u32, String>>,
}
impl Serving {
    fn retire(&self) {
        self.retiring.store(true, Ordering::Release);
        self.helper.close();
    }
}
pub struct TailcatRuntime {
    born: std::time::Instant,
    device: Arc<DeviceRuntime>,
    reports: mpsc::Sender<(std::sync::Weak<Serving>, daemon_to_server::Payload)>,
    report_rx:
        tokio::sync::Mutex<mpsc::Receiver<(std::sync::Weak<Serving>, daemon_to_server::Payload)>>,
    active: Mutex<Option<Arc<Serving>>>,
    epoch: AtomicU64,
}
impl TailcatRuntime {
    pub fn new(device: Arc<DeviceRuntime>) -> Arc<Self> {
        let (reports, report_rx) = mpsc::channel(256);
        Arc::new(Self {
            born: std::time::Instant::now(),
            device,
            reports,
            report_rx: tokio::sync::Mutex::new(report_rx),
            active: Mutex::new(None),
            epoch: AtomicU64::new(0),
        })
    }
    pub fn start(self: &Arc<Self>, daemon: String) {
        self.close_all();
        if std::env::var("COFLUX_TAILCAT").as_deref() != Ok("1") {
            return;
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                let started = std::time::Instant::now();
                if runtime.epoch.load(Ordering::Acquire) != epoch {
                    return;
                }
                let Ok(exe) = std::env::current_exe() else {
                    return;
                };
                let Some(parent) = exe.parent() else { return };
                let helper = Helper::spawn(&parent.join("coflux-transport")).await;
                if let Ok((helper, mut accepted, public_key)) = helper {
                    let serving = Arc::new(Serving {
                        helper,
                        daemon: daemon.clone(),
                        public_key: public_key.clone(),
                        epoch,
                        health_now: tokio::sync::Notify::new(),
                        retiring: AtomicBool::new(false),
                        grants: Mutex::new(None),
                        channels: Mutex::new(HashMap::new()),
                    });
                    {
                        let mut active = runtime.active.lock().unwrap();
                        if runtime.epoch.load(Ordering::Acquire) != epoch {
                            serving.retire();
                            return;
                        };
                        *active = Some(serving.clone());
                    }
                    runtime.report(
                        &serving,
                        daemon_to_server::Payload::DeviceTailcatIdentity(
                            wire::DeviceTailcatIdentity {
                                node_public_key: public_key,
                                transport_version: 1,
                            },
                        ),
                    );
                    while let Some((stream, rx)) = accepted.recv().await {
                        let this = runtime.clone();
                        let serving = serving.clone();
                        tokio::spawn(async move {
                            this.channel(serving, stream, rx).await;
                        });
                    }
                    let probation = std::env::var("COFLUX_TRANSPORT_PROBATION_MS")
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    if !serving.retiring.load(Ordering::Acquire)
                        && runtime.born.elapsed() < Duration::from_millis(probation)
                    {
                        coflux_protocol::logln!(
                            "[worker] native helper exited during candidate probation"
                        );
                        std::process::exit(1);
                    }
                    serving.retire();
                    let mut active = runtime.active.lock().unwrap();
                    if active
                        .as_ref()
                        .is_some_and(|value| Arc::ptr_eq(value, &serving))
                    {
                        runtime.device.close_tailcats();
                        *active = None
                    }
                }
                if started.elapsed() >= Duration::from_secs(60) {
                    attempt = 0;
                } else {
                    attempt = (attempt + 1).min(6);
                }
                tokio::time::sleep(Duration::from_millis((250 * (1u64 << attempt)).min(10_000)))
                    .await;
            }
        });
    }
    pub fn close_all(&self) {
        let mut active = self.active.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::AcqRel);
        if let Some(serving) = active.take() {
            serving.retire();
        }
        self.device.close_tailcats();
    }
    fn current(&self, serving: &Arc<Serving>) -> bool {
        !serving.helper.is_closed()
            && self
                .active
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, serving))
    }
    fn close_owned(&self, serving: &Arc<Serving>, channel: &str) {
        let active = self.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, serving))
        {
            self.device.close_tailcat(channel);
        }
    }
    fn handle_owned(&self, serving: &Arc<Serving>, channel: &str, bytes: &[u8]) -> bool {
        let active = self.active.lock().unwrap();
        active
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, serving))
            && !serving.helper.is_closed()
            && self.device.handle_tailcat_frame(channel, bytes)
    }
    fn report(&self, serving: &Arc<Serving>, payload: daemon_to_server::Payload) {
        if self
            .reports
            .try_send((Arc::downgrade(serving), payload))
            .is_err()
        {
            serving.retire();
        }
    }
    /// Reports are consumed only by the authenticated socket loop. A private
    /// epoch-bound queue prevents delayed reports crossing reconnects/restarts.
    pub async fn next_report(&self) -> Vec<u8> {
        let mut rx = self.report_rx.lock().await;
        loop {
            let Some((owner, payload)) = rx.recv().await else {
                std::future::pending::<()>().await;
                unreachable!()
            };
            let Some(serving) = owner.upgrade() else {
                continue;
            };
            if serving.epoch == self.epoch.load(Ordering::Acquire) && self.current(&serving) {
                return wire::DaemonToServer {
                    payload: Some(payload),
                }
                .encode_to_vec();
            }
        }
    }
    pub fn configure(self: &Arc<Self>, configuration: wire::DeviceTailcatConfigure) {
        let Some(serving) = self.active.lock().unwrap().clone() else {
            return;
        };
        let this = self.clone();
        if serving.grants.lock().unwrap().is_some() {
            if configuration.refresh_only {
                serving.health_now.notify_one();
            } else {
                serving.retire();
            }
            return;
        }
        tokio::spawn(async move {
            if configuration.transport_version != 1 || configuration.account_id.is_empty() {
                serving.retire();
                return;
            }
            let Ok(region) = serde_json::from_slice::<Value>(&configuration.region_json) else {
                serving.retire();
                return;
            };
            let Ok(response) = serving
                .helper
                .request(json!({"op":"serve","region":region}))
                .await
            else {
                serving.retire();
                return;
            };
            let active = this.active.lock().unwrap();
            if !active
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &serving))
                || serving.helper.is_closed()
            {
                return;
            }
            let Some(address) = response["address"].as_str() else {
                serving.retire();
                return;
            };
            *serving.grants.lock().unwrap() = Some(Grants::new(
                configuration.account_id,
                serving.daemon.clone(),
            ));
            let monitor = serving.clone();
            tokio::spawn(async move {
                let mut failures = 0;
                loop {
                    let delay = if failures == 0 { 10 } else { 1 };
                    tokio::select! { _ = tokio::time::sleep(Duration::from_secs(delay)) => {}, _ = monitor.health_now.notified() => {} }
                    if monitor.helper.is_closed() {
                        break;
                    }
                    if monitor.helper.request(json!({"op":"health"})).await.is_ok() {
                        failures = 0;
                    } else {
                        failures += 1;
                        if failures >= 3 {
                            monitor.retire();
                            break;
                        }
                    }
                }
            });
            this.report(
                &serving,
                daemon_to_server::Payload::DeviceTailcatEndpoint(wire::DeviceTailcatEndpoint {
                    node_public_key: serving.public_key.clone(),
                    address: address.into(),
                    transport_version: 1,
                }),
            );
        });
    }
    pub fn grant(self: &Arc<Self>, grant: wire::DeviceTailcatGrant) {
        let active = self.active.lock().unwrap();
        let Some(serving) = active.clone() else {
            return;
        };
        let channel = grant.channel_id.clone();
        let key = grant.node_public_key.clone();
        let installed = serving
            .grants
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|grants| grants.install(grant, now()).is_ok());
        if !installed {
            if serving
                .grants
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|grants| grants.needs_rotation())
            {
                serving.retire();
            }
            self.report(
                &serving,
                daemon_to_server::Payload::DeviceTailcatInstalled(wire::DeviceTailcatInstalled {
                    channel_id: channel,
                    ok: false,
                }),
            );
            return;
        }
        drop(active);
        let this = self.clone();
        tokio::spawn(async move {
            let allowed = serving
                .helper
                .request(json!({"op":"allow","publicKey":key}))
                .await
                .is_ok();
            let active = this.active.lock().unwrap();
            if !active
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &serving))
                || serving.helper.is_closed()
            {
                return;
            }
            if !allowed {
                serving.retire();
            }
            let ok = allowed
                && serving
                    .grants
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|grants| grants.pending(&channel, now()));
            this.report(
                &serving,
                daemon_to_server::Payload::DeviceTailcatInstalled(wire::DeviceTailcatInstalled {
                    channel_id: channel,
                    ok,
                }),
            );
        });
    }
    pub fn revoke(self: &Arc<Self>, channels: Vec<String>) {
        let Some(serving) = self.active.lock().unwrap().clone() else {
            return;
        };
        {
            let mut grants = serving.grants.lock().unwrap();
            if let Some(grants) = grants.as_mut() {
                for channel in &channels {
                    grants.revoke(channel);
                }
            }
        }
        let streams: Vec<u32> = serving
            .channels
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, channel)| channels.contains(channel))
            .map(|(stream, _)| *stream)
            .collect();
        for channel in channels {
            self.close_owned(&serving, &channel);
        }
        tokio::spawn(async move {
            for stream in streams {
                let _ = serving
                    .helper
                    .request(json!({"op":"close","stream":stream}))
                    .await;
            }
        });
    }
    async fn channel(
        self: Arc<Self>,
        serving: Arc<Serving>,
        stream: u32,
        mut rx: mpsc::Receiver<Frame>,
    ) {
        let authenticate = async {
            let first = rx.recv().await.ok_or(())?;
            if first.bytes.len() > 512 {
                return Err(());
            }
            let first: Value = serde_json::from_slice(&first.bytes).map_err(|_| ())?;
            let channel = first["channelId"].as_str().ok_or(())?.to_string();
            if channel.len() > 255 || !self.current(&serving) {
                return Err(());
            }
            let nonce = tailcat_auth::challenge();
            if !serving.helper.send(stream, nonce.to_vec()) {
                return Err(());
            }
            let proof = rx.recv().await.ok_or(())?;
            if proof.bytes.len() != 32 || !self.current(&serving) {
                return Err(());
            }
            let receiver = {
                let active = self.active.lock().unwrap();
                if !active
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, &serving))
                    || serving.helper.is_closed()
                {
                    return Err(());
                }
                let mut grants = serving.grants.lock().unwrap();
                let grant = grants
                    .as_mut()
                    .ok_or(())?
                    .consume(&channel, &nonce, &proof.bytes, now())
                    .map_err(|_| ())?;
                let receiver = self.device.open_tailcat(&grant).map_err(|_| ())?;
                serving
                    .channels
                    .lock()
                    .unwrap()
                    .insert(stream, channel.clone());
                receiver
            };
            if serving
                .helper
                .request(json!({"op":"authorize","stream":stream}))
                .await
                .is_err()
                || !self.current(&serving)
                || !serving.helper.send(stream, b"ok".to_vec())
            {
                self.close_owned(&serving, &channel);
                return Err(());
            }
            {
                let active = self.active.lock().unwrap();
                if !active
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, &serving))
                {
                    return Err(());
                };
                self.report(
                    &serving,
                    daemon_to_server::Payload::DeviceTailcatOpened(wire::DeviceTailcatOpened {
                        channel_id: channel.clone(),
                    }),
                );
            }
            Ok((channel, receiver))
        };
        if let Ok(Ok((channel, mut outgoing))) =
            tokio::time::timeout(Duration::from_secs(5), authenticate).await
        {
            loop {
                tokio::select! {
                    frame=rx.recv()=>{let Some(frame)=frame else{break};if !self.handle_owned(&serving,&channel,&frame.bytes){break}}
                    frame=outgoing.recv()=>{let Some(frame)=frame else{break};if !serving.helper.send(stream,frame){break}}
                }
            }
            self.close_owned(&serving, &channel);
        }
        let removed = serving.channels.lock().unwrap().remove(&stream);
        if let Some(channel) = removed {
            self.close_owned(&serving, &channel);
        }
        let _ = serving
            .helper
            .request(json!({"op":"close","stream":stream}))
            .await;
    }
}
