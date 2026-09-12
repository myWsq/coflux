//! Private, bounded stdio ownership for the native networking helper.

use coflux_protocol::MAX_DEVICE_FRAME_BYTES;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};

const BUDGET: usize = 128 * 1024 * 1024;
const CONTROL: usize = 64 * 1024;
type Pending = oneshot::Sender<Result<Value, String>>;
pub struct Frame {
    pub stream: u32,
    pub bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
    _stream_permit: Option<OwnedSemaphorePermit>,
}
enum Out {
    Control(Frame),
    Data(Frame),
}

struct StreamQueue {
    sender: Option<mpsc::Sender<Frame>>,
    budget: Arc<Semaphore>,
}
pub struct Helper {
    out: mpsc::Sender<Out>,
    requests: Mutex<HashMap<u32, Pending>>,
    streams: Mutex<HashMap<u32, StreamQueue>>,
    next: AtomicU32,
    stopped: AtomicBool,
    stop: watch::Sender<bool>,
    budget: Arc<Semaphore>,
}

impl Helper {
    pub async fn spawn(
        path: &Path,
    ) -> Result<
        (
            Arc<Self>,
            mpsc::Receiver<(u32, mpsc::Receiver<Frame>)>,
            String,
        ),
        String,
    > {
        if !path.is_absolute() {
            return Err("transport path must be absolute".into());
        }
        let mut child = tokio::process::Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "transport helper unavailable")?;
        let mut input = child.stdin.take().ok_or("missing transport input")?;
        let mut output = child.stdout.take().ok_or("missing transport output")?;
        let (tx, mut rx) = mpsc::channel(256);
        let (accepted_tx, accepted_rx) = mpsc::channel(256);
        let helper = Arc::new(Self {
            out: tx,
            requests: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            next: AtomicU32::new(1),
            stopped: AtomicBool::new(false),
            stop: watch::channel(false).0,
            budget: Arc::new(Semaphore::new(BUDGET)),
        });
        let owner = helper.clone();
        tokio::spawn(async move {
            let mut stopped = owner.stop.subscribe();
            if *stopped.borrow() {
                let _ = child.kill().await;
                return;
            }
            tokio::select! { _=child.wait()=>{}, _=stopped.changed()=>{let _=child.kill().await;} }
            owner.close();
        });
        let owner = helper.clone();
        tokio::spawn(async move {
            let mut stopped = owner.stop.subscribe();
            loop {
                if *stopped.borrow() {
                    break;
                }
                let out = tokio::select! { _=stopped.changed()=>break, out=rx.recv()=>match out{Some(v)=>v,None=>break} };
                let (kind, stream, bytes) = match &out {
                    Out::Control(v) => (1u8, 0u32, v.bytes.as_slice()),
                    Out::Data(f) => (2, f.stream, f.bytes.as_slice()),
                };
                let mut header = [0u8; 9];
                header[..4].copy_from_slice(&((bytes.len() + 5) as u32).to_be_bytes());
                header[4] = kind;
                header[5..].copy_from_slice(&stream.to_be_bytes());
                let result = tokio::time::timeout(Duration::from_secs(20), async {
                    input.write_all(&header).await?;
                    input.write_all(bytes).await
                })
                .await;
                if !matches!(result, Ok(Ok(()))) {
                    break;
                }
            }
            owner.close();
        });
        let owner = helper.clone();
        tokio::spawn(async move {
            let mut stopped = owner.stop.subscribe();
            loop {
                if *stopped.borrow() {
                    break;
                }
                let frame = tokio::select! { _=stopped.changed()=>break, value=async {
                    let size=output.read_u32().await.map_err(|_|())? as usize;
                    if size<=5 || size>MAX_DEVICE_FRAME_BYTES+5{return Err(())}
                    let kind=output.read_u8().await.map_err(|_|())?;
                    let stream=output.read_u32().await.map_err(|_|())?;
                    let n=size-5;
                    if !((kind==1 && stream==0 && n<=CONTROL)||(kind==2 && stream!=0)){return Err(())}
                    let stream_budget = if kind == 2 { owner.streams.lock().unwrap().get(&stream).filter(|q| q.sender.is_some()).map(|q| q.budget.clone()) } else { None };
                    let stream_permit = stream_budget.and_then(|budget| budget.try_acquire_many_owned(n as u32).ok());
                    let permit=owner.budget.clone().try_acquire_many_owned(n as u32).ok();
                    if permit.is_none() || (kind == 2 && stream_permit.is_none()) {
                        if kind == 1 { return Err(()) }
                        tokio::io::copy(&mut (&mut output).take(n as u64), &mut tokio::io::sink()).await.map_err(|_|())?;
                        owner.reject_stream(stream);
                        return Ok(None);
                    }
                    let mut bytes=vec![0;n];output.read_exact(&mut bytes).await.map_err(|_|())?;
                    Ok(Some((kind,Frame{stream,bytes,_permit:permit.unwrap(),_stream_permit:stream_permit})))
                }=>match value{Ok(v)=>v,Err(())=>break} };
                let Some((kind, frame)) = frame else { continue };
                if kind == 2 {
                    let stream = frame.stream;
                    let sender = owner
                        .streams
                        .lock()
                        .unwrap()
                        .get(&stream)
                        .and_then(|q| q.sender.clone());
                    if sender.is_none_or(|sender| sender.try_send(frame).is_err()) {
                        owner.reject_stream(stream);
                    }
                    continue;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&frame.bytes) else {
                    break;
                };
                if let Some(id) = value["id"].as_u64().and_then(|v| u32::try_from(v).ok()) {
                    if let Some(waiter) = owner.requests.lock().unwrap().remove(&id) {
                        let result = if value["ok"] == true {
                            Ok(value)
                        } else {
                            Err("transport operation rejected".into())
                        };
                        let _ = waiter.send(result);
                    }
                } else if let Some(stream) =
                    value["stream"].as_u64().and_then(|v| u32::try_from(v).ok())
                {
                    match value["op"].as_str() {
                        Some("accepted") if stream >= 0x80000000 => {
                            let (tx, rx) = mpsc::channel(256);
                            let mut streams = owner.streams.lock().unwrap();
                            if streams.len() >= 256
                                || streams
                                    .insert(
                                        stream,
                                        StreamQueue {
                                            sender: Some(tx),
                                            budget: Arc::new(Semaphore::new(32 * 1024 * 1024)),
                                        },
                                    )
                                    .is_some()
                            {
                                break;
                            };
                            drop(streams);
                            if accepted_tx.try_send((stream, rx)).is_err() {
                                break;
                            }
                        }
                        Some("closed") => {
                            owner.streams.lock().unwrap().remove(&stream);
                        }
                        _ => break,
                    }
                } else {
                    break;
                }
            }
            owner.close();
        });
        let hello = match helper.request(json!({"op":"hello","version":1})).await {
            Ok(value) => value,
            Err(error) => {
                helper.close();
                return Err(error);
            }
        };
        if let Some(version) =
            option_env!("COFLUX_RELEASE_VERSION").filter(|version| version.starts_with('v'))
        {
            if hello["releaseVersion"].as_str() != Some(version) {
                helper.close();
                return Err("transport release mismatch".into());
            }
        }
        let key = match hello["publicKey"]
            .as_str()
            .filter(|_| hello["version"] == 1)
        {
            Some(value) => value.to_string(),
            None => {
                helper.close();
                return Err("incompatible transport helper".into());
            }
        };
        Ok((helper, accepted_rx, key))
    }

    fn reject_stream(self: &Arc<Self>, stream: u32) {
        let first = self
            .streams
            .lock()
            .unwrap()
            .get_mut(&stream)
            .is_some_and(|q| q.sender.take().is_some());
        if first {
            let owner = self.clone();
            tokio::spawn(async move {
                let _ = owner.request(json!({"op":"close","stream":stream})).await;
            });
        }
    }
    pub async fn request(&self, mut value: Value) -> Result<Value, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("transport closed".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            self.close();
            return Err("transport request id exhausted".into());
        }
        value["id"] = json!(id);
        let bytes = serde_json::to_vec(&value).map_err(|_| "invalid transport request")?;
        if bytes.len() > CONTROL {
            return Err("transport control exceeds limit".into());
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.requests.lock().unwrap();
            if pending.len() >= 256 {
                return Err("transport request limit".into());
            };
            pending.insert(id, tx);
        }
        let permit = match self
            .budget
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
        {
            Ok(value) => value,
            Err(_) => {
                self.requests.lock().unwrap().remove(&id);
                return Err("transport control budget exhausted".into());
            }
        };
        if self
            .out
            .try_send(Out::Control(Frame {
                stream: 0,
                bytes,
                _permit: permit,
                _stream_permit: None,
            }))
            .is_err()
        {
            self.requests.lock().unwrap().remove(&id);
            return Err("transport queue full".into());
        }
        let result = tokio::time::timeout(Duration::from_secs(20), rx).await;
        self.requests.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(value)) => value,
            _ => {
                self.close();
                Err("transport request failed".into())
            }
        }
    }
    pub fn send(&self, stream: u32, bytes: Vec<u8>) -> bool {
        if bytes.is_empty()
            || bytes.len() > MAX_DEVICE_FRAME_BYTES
            || self.stopped.load(Ordering::Acquire)
        {
            return false;
        }
        let Ok(permit) = self
            .budget
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
        else {
            return false;
        };
        self.out
            .try_send(Out::Data(Frame {
                stream,
                bytes,
                _permit: permit,
                _stream_permit: None,
            }))
            .is_ok()
    }
    pub fn close(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        };
        self.budget.close();
        self.streams.lock().unwrap().clear();
        for (_, request) in self.requests.lock().unwrap().drain() {
            let _ = request.send(Err("transport closed".into()));
        }
        self.stop.send_replace(true);
    }
    pub fn is_closed(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}
