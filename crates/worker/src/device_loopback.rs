//! Loopback tunnel of the Device channel (plan 20260924-remote-localhost-tunnel).
//!
//! A client holding `DEVICE_SCOPE_RPC` opens TCP connections to ports on this device's own
//! loopback interface, multiplexed on its Device channel by a client-chosen connection id. The
//! desktop app's built-in browser uses it so that `localhost` in a remote workspace reaches the
//! workspace's device.
//!
//! Not to be confused with `tunnel.rs`, the bridge of the *central* port proxy: that one lives on
//! the server WebSocket, has no flow control and is addressed by the centre. This module lives on
//! a Device channel, is addressed by the client, and never drops bytes.
//!
//! Invariants:
//! - The client names a port, never an address. The worker dials `127.0.0.1:<port>` and falls
//!   back to `[::1]:<port>`; "refused" is reported only when both refuse.
//! - Credit-based flow control per direction, counted in data frames (see the constants). The
//!   worker→client direction additionally has a channel-wide cap, [`CHANNEL_WINDOW_FRAMES`], so
//!   tunnel data can never occupy more than a quarter of the helper's shared 256-record outbound
//!   queue (`tailcat_ipc.rs`) and starve another lane — PTY lanes included. That credit returns
//!   only when the client acknowledges, and the client acknowledges every data frame it receives.
//! - A frame that cannot be queued is never skipped: the connection closes instead. If even the
//!   close cannot be queued, the whole channel closes, so both ends always see the close.
//! - `handle` runs synchronously on the channel's task and never blocks: bytes towards a socket
//!   go through a bounded per-connection queue, and a full queue closes the connection.
//! - Dropping the [`LoopbackTable`] (it lives in the channel entry) aborts every connection, so
//!   every path that removes a channel tears its tunnels down.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::wire::{
    device_envelope::Payload, DeviceLoopbackAck, DeviceLoopbackClose, DeviceLoopbackData,
    DeviceLoopbackFailed, DeviceLoopbackFailure, DeviceLoopbackOpen, DeviceLoopbackOpened,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Semaphore};
use tokio::task::AbortHandle;

/// Largest payload of one `DeviceLoopbackData` frame, both directions.
pub const FRAME_BYTES: usize = 64 * 1024;
/// Unacknowledged worker→client data frames per connection (512 KiB at most).
pub const CONNECTION_WINDOW_FRAMES: usize = 8;
/// Unacknowledged worker→client data frames across all connections of one channel. A quarter of
/// the helper's 256-record outbound queue is 64; together with the at most 16 acknowledgements
/// the client's own window (below) can provoke, tunnel records stay within that quarter.
pub const CHANNEL_WINDOW_FRAMES: usize = 48;
/// Unacknowledged client→worker data frames per connection. The client keeps to it; the worker's
/// per-connection write queue has exactly this capacity, and overflowing it closes the connection.
pub const CLIENT_CONNECTION_WINDOW_FRAMES: usize = 8;
/// Concurrent tunnel connections (connecting or open) per channel.
pub const CHANNEL_CONNECTION_LIMIT: usize = 64;
/// Concurrent tunnel connections across every channel of this worker.
pub const WORKER_CONNECTION_LIMIT: usize = 256;
/// Per-address dial deadline; loopback answers instantly unless the listener's backlog is full.
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a table's frames go: the channel's own bounded queue.
pub trait Outlet: Send + Sync + 'static {
    /// Queue one payload for the client. `false` when the channel queue is full or gone.
    fn send(&self, payload: Payload) -> bool;
    /// Close the whole channel; used only when even a connection close cannot be queued.
    fn close_channel(&self);
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub connection_window: usize,
    pub channel_window: usize,
    pub client_connection_window: usize,
    pub channel_connections: usize,
    pub worker_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connection_window: CONNECTION_WINDOW_FRAMES,
            channel_window: CHANNEL_WINDOW_FRAMES,
            client_connection_window: CLIENT_CONNECTION_WINDOW_FRAMES,
            channel_connections: CHANNEL_CONNECTION_LIMIT,
            worker_connections: WORKER_CONNECTION_LIMIT,
        }
    }
}

/// The only two addresses a tunnel connection may reach for `port`, in dial order.
/// `None` for anything outside 1..=65535.
pub fn dial_targets(port: u32) -> Option<[SocketAddr; 2]> {
    let port = u16::try_from(port).ok().filter(|port| *port != 0)?;
    Some([
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ])
}

/// Is this payload part of the loopback tunnel (either direction)?
pub fn is_loopback_payload(payload: &Payload) -> bool {
    matches!(
        payload,
        Payload::LoopbackOpen(_)
            | Payload::LoopbackOpened(_)
            | Payload::LoopbackFailed(_)
            | Payload::LoopbackData(_)
            | Payload::LoopbackAck(_)
            | Payload::LoopbackClose(_)
    )
}

/// Owned by the channel entry; dropping it tears every tunnel connection of the channel down.
pub struct LoopbackTable {
    inner: Arc<Inner>,
}

/// A cheap handle for dispatching a client frame without holding the channels lock.
#[derive(Clone)]
pub struct LoopbackHandle {
    inner: Arc<Inner>,
}

impl LoopbackTable {
    pub fn new(outlet: Arc<dyn Outlet>, worker_connections: Arc<AtomicUsize>) -> Self {
        Self::with_limits(outlet, worker_connections, Limits::default())
    }

    pub fn with_limits(
        outlet: Arc<dyn Outlet>,
        worker_connections: Arc<AtomicUsize>,
        limits: Limits,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                outlet: Mutex::new(Some(outlet)),
                state: Mutex::new(State::default()),
                lane_credit: Semaphore::new(limits.channel_window),
                lane_outstanding: Mutex::new(0),
                worker_connections,
                limits,
            }),
        }
    }

    pub fn handle(&self) -> LoopbackHandle {
        LoopbackHandle {
            inner: self.inner.clone(),
        }
    }
}

impl Drop for LoopbackTable {
    fn drop(&mut self) {
        self.inner.shutdown();
    }
}

impl LoopbackHandle {
    /// Consume one client frame. Synchronous and non-blocking by contract.
    pub fn dispatch(&self, payload: Payload) {
        match payload {
            Payload::LoopbackOpen(open) => self.inner.open(open),
            Payload::LoopbackData(data) => self.inner.client_data(data),
            Payload::LoopbackAck(ack) => self.inner.client_ack(ack),
            Payload::LoopbackClose(close) => self.inner.client_close(close.connection_id),
            // Opened/Failed are worker-initiated; the scope gate already refused them.
            _ => {}
        }
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    next_serial: u64,
    connections: HashMap<u32, Connection>,
}

struct Connection {
    serial: u64,
    opened: bool,
    /// Towards the socket. `None` once the client closed the connection: the task drains what
    /// is queued, shuts the socket down and ends.
    writer: Option<mpsc::Sender<Vec<u8>>>,
    credit: Arc<ConnectionCredit>,
    task: Option<AbortHandle>,
}

struct ConnectionCredit {
    permits: Semaphore,
    outstanding: Mutex<usize>,
}

struct Inner {
    outlet: Mutex<Option<Arc<dyn Outlet>>>,
    state: Mutex<State>,
    /// Channel-wide worker→client credit, returned only by client acknowledgements.
    lane_credit: Semaphore,
    lane_outstanding: Mutex<usize>,
    worker_connections: Arc<AtomicUsize>,
    limits: Limits,
}

enum Ending {
    /// The client closed the connection; nothing to report back.
    ClientClosed,
    /// The device side closed or failed; the client must be told.
    DeviceClosed,
}

impl Inner {
    // Lock discipline: `outlet` is never called while `state` or `outlet` is held, because the
    // outlet takes the runtime's channels lock and the runtime drops tables (taking `state`)
    // while holding it.
    fn outlet(&self) -> Option<Arc<dyn Outlet>> {
        self.outlet.lock().unwrap().clone()
    }

    fn send(&self, payload: Payload) -> bool {
        self.outlet().is_some_and(|outlet| outlet.send(payload))
    }

    fn close_channel(&self) {
        if let Some(outlet) = self.outlet() {
            outlet.close_channel();
        }
    }

    /// Tell the client a connection is closed; if even that cannot be queued, the channel goes.
    fn notify_closed(&self, connection_id: u32) {
        if !self.send(Payload::LoopbackClose(DeviceLoopbackClose { connection_id })) {
            self.close_channel();
        }
    }

    fn fail_open(&self, connection_id: u32, reason: DeviceLoopbackFailure, message: &str) {
        let failed = Payload::LoopbackFailed(DeviceLoopbackFailed {
            connection_id,
            reason: reason as i32,
            message: message.to_string(),
        });
        if !self.send(failed) {
            self.close_channel();
        }
    }

    fn release_worker_slot(&self) {
        self.worker_connections.fetch_sub(1, Ordering::AcqRel);
    }

    fn reserve_worker_slot(&self) -> bool {
        self.worker_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.limits.worker_connections).then_some(count + 1)
            })
            .is_ok()
    }

    fn open(self: &Arc<Self>, open: DeviceLoopbackOpen) {
        let DeviceLoopbackOpen {
            connection_id,
            port,
        } = open;
        let Some(targets) = dial_targets(port) else {
            self.fail_open(
                connection_id,
                DeviceLoopbackFailure::Invalid,
                "port must be 1-65535",
            );
            return;
        };
        if connection_id == 0 {
            self.fail_open(
                connection_id,
                DeviceLoopbackFailure::Invalid,
                "connection id must be non-zero",
            );
            return;
        }
        let (serial, receiver, credit) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            if state.connections.contains_key(&connection_id) {
                drop(state);
                // Never disturb the live connection that owns the id.
                self.fail_open(
                    connection_id,
                    DeviceLoopbackFailure::Invalid,
                    "connection id already in use",
                );
                return;
            }
            if state.connections.len() >= self.limits.channel_connections
                || !self.reserve_worker_slot()
            {
                drop(state);
                self.fail_open(
                    connection_id,
                    DeviceLoopbackFailure::Limit,
                    "too many tunnel connections",
                );
                return;
            }
            state.next_serial += 1;
            let serial = state.next_serial;
            let (writer, receiver) = mpsc::channel(self.limits.client_connection_window.max(1));
            let credit = Arc::new(ConnectionCredit {
                permits: Semaphore::new(self.limits.connection_window),
                outstanding: Mutex::new(0),
            });
            state.connections.insert(
                connection_id,
                Connection {
                    serial,
                    opened: false,
                    writer: Some(writer),
                    credit: credit.clone(),
                    task: None,
                },
            );
            (serial, receiver, credit)
        };
        let task = tokio::spawn(
            self.clone()
                .run(connection_id, serial, targets, receiver, credit),
        )
        .abort_handle();
        let mut state = self.state.lock().unwrap();
        match state.connections.get_mut(&connection_id) {
            Some(connection) if connection.serial == serial && !state.closed => {
                connection.task = Some(task);
            }
            // Already finished (or the table shut down) before the handle could be stored.
            _ => task.abort(),
        }
    }

    fn client_data(&self, data: DeviceLoopbackData) {
        let DeviceLoopbackData {
            connection_id,
            data,
        } = data;
        let writer = {
            let state = self.state.lock().unwrap();
            state
                .connections
                .get(&connection_id)
                .map(|connection| connection.writer.clone())
        };
        // Unknown id: the connection is already gone on this side and its close is on its way.
        let Some(writer) = writer else { return };
        // Data after the client's own close is a protocol violation, as is an out-of-range frame.
        let Some(writer) = writer.filter(|_| !data.is_empty() && data.len() <= FRAME_BYTES)
        else {
            self.close_connection(connection_id);
            return;
        };
        match writer.try_send(data) {
            Ok(()) => {}
            // The client overran its window: queueing is impossible and skipping would corrupt
            // the stream, so the connection closes.
            Err(mpsc::error::TrySendError::Full(_)) => self.close_connection(connection_id),
            // The task already ended; it reports its own close.
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }

    fn client_ack(&self, ack: DeviceLoopbackAck) {
        let frames = ack.frames as usize;
        if frames == 0 {
            return;
        }
        {
            let mut outstanding = self.lane_outstanding.lock().unwrap();
            let released = frames.min(*outstanding);
            *outstanding -= released;
            self.lane_credit.add_permits(released);
        }
        let credit = self
            .state
            .lock()
            .unwrap()
            .connections
            .get(&ack.connection_id)
            .map(|connection| connection.credit.clone());
        if let Some(credit) = credit {
            let mut outstanding = credit.outstanding.lock().unwrap();
            let released = frames.min(*outstanding);
            *outstanding -= released;
            credit.permits.add_permits(released);
        }
    }

    fn client_close(&self, connection_id: u32) {
        let aborted = {
            let mut state = self.state.lock().unwrap();
            let Some(connection) = state.connections.get_mut(&connection_id) else {
                return;
            };
            if connection.opened {
                // Graceful: the task writes what is queued, shuts the socket down and ends.
                connection.writer = None;
                None
            } else {
                // Still dialing: nothing to flush.
                state.connections.remove(&connection_id)
            }
        };
        if let Some(connection) = aborted {
            if let Some(task) = connection.task {
                task.abort();
            }
            self.release_worker_slot();
        }
    }

    /// Worker-initiated close from `dispatch`: abort the connection and tell the client.
    fn close_connection(&self, connection_id: u32) {
        let removed = self
            .state
            .lock()
            .unwrap()
            .connections
            .remove(&connection_id);
        let Some(connection) = removed else { return };
        if let Some(task) = connection.task {
            task.abort();
        }
        self.release_worker_slot();
        self.notify_closed(connection_id);
    }

    /// Remove the connection if it still is the one this task owns. `true` when it was.
    fn finish(&self, connection_id: u32, serial: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state
            .connections
            .get(&connection_id)
            .is_some_and(|connection| connection.serial == serial)
        {
            state.connections.remove(&connection_id);
            drop(state);
            self.release_worker_slot();
            true
        } else {
            false
        }
    }

    fn mark_opened(&self, connection_id: u32, serial: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        match state.connections.get_mut(&connection_id) {
            Some(connection) if connection.serial == serial => {
                connection.opened = true;
                true
            }
            _ => false,
        }
    }

    fn shutdown(&self) {
        let removed: Vec<Connection> = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.connections.drain().map(|(_, connection)| connection).collect()
        };
        for connection in &removed {
            if let Some(task) = &connection.task {
                task.abort();
            }
            connection.credit.permits.close();
        }
        for _ in &removed {
            self.release_worker_slot();
        }
        self.lane_credit.close();
        self.outlet.lock().unwrap().take();
    }

    async fn run(
        self: Arc<Self>,
        connection_id: u32,
        serial: u64,
        targets: [SocketAddr; 2],
        receiver: mpsc::Receiver<Vec<u8>>,
        credit: Arc<ConnectionCredit>,
    ) {
        let stream = match dial(targets).await {
            Ok(stream) => stream,
            Err((reason, message)) => {
                if self.finish(connection_id, serial) {
                    self.fail_open(connection_id, reason, &message);
                }
                return;
            }
        };
        if !self.mark_opened(connection_id, serial) {
            // The client closed it (or the channel went) while dialing.
            return;
        }
        if !self.send(Payload::LoopbackOpened(DeviceLoopbackOpened { connection_id })) {
            if self.finish(connection_id, serial) {
                self.notify_closed(connection_id);
            }
            return;
        }
        let _ = stream.set_nodelay(true);
        let (read, write) = stream.into_split();
        let ending = tokio::select! {
            ending = self.pump_to_client(connection_id, &credit, read) => ending,
            ending = self.pump_to_device(connection_id, receiver, write) => ending,
        };
        if self.finish(connection_id, serial) {
            if let Ending::DeviceClosed = ending {
                self.notify_closed(connection_id);
            }
        }
    }

    /// Socket → client, one frame per read, each waiting for connection and channel credit.
    /// Reading first and waiting for credit afterwards keeps idle connections (keep-alive,
    /// quiet WebSockets) from holding channel credit they are not using.
    async fn pump_to_client(
        &self,
        connection_id: u32,
        credit: &ConnectionCredit,
        mut read: OwnedReadHalf,
    ) -> Ending {
        let mut buffer = vec![0u8; FRAME_BYTES];
        loop {
            let count = match read.read(&mut buffer).await {
                Ok(0) | Err(_) => return Ending::DeviceClosed,
                Ok(count) => count,
            };
            let Ok(permit) = credit.permits.acquire().await else {
                return Ending::DeviceClosed;
            };
            permit.forget();
            let Ok(permit) = self.lane_credit.acquire().await else {
                credit.permits.add_permits(1);
                return Ending::DeviceClosed;
            };
            permit.forget();
            *credit.outstanding.lock().unwrap() += 1;
            *self.lane_outstanding.lock().unwrap() += 1;
            let frame = Payload::LoopbackData(DeviceLoopbackData {
                connection_id,
                data: buffer[..count].to_vec(),
            });
            if !self.send(frame) {
                // Not queued, so not in flight: return the credit, then close — never skip.
                {
                    let mut outstanding = credit.outstanding.lock().unwrap();
                    *outstanding = outstanding.saturating_sub(1);
                    credit.permits.add_permits(1);
                }
                {
                    let mut outstanding = self.lane_outstanding.lock().unwrap();
                    *outstanding = outstanding.saturating_sub(1);
                    self.lane_credit.add_permits(1);
                }
                return Ending::DeviceClosed;
            }
        }
    }

    /// Client → socket. Acknowledges after writing, coalescing whatever was already queued.
    async fn pump_to_device(
        &self,
        connection_id: u32,
        mut receiver: mpsc::Receiver<Vec<u8>>,
        mut write: OwnedWriteHalf,
    ) -> Ending {
        while let Some(chunk) = receiver.recv().await {
            if write.write_all(&chunk).await.is_err() {
                return Ending::DeviceClosed;
            }
            let mut frames = 1u32;
            while let Ok(chunk) = receiver.try_recv() {
                if write.write_all(&chunk).await.is_err() {
                    return Ending::DeviceClosed;
                }
                frames += 1;
            }
            if !self.send(Payload::LoopbackAck(DeviceLoopbackAck {
                connection_id,
                frames,
            })) {
                return Ending::DeviceClosed;
            }
        }
        // The client closed: everything it sent is written.
        let _ = write.shutdown().await;
        Ending::ClientClosed
    }
}

fn unavailable_family(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::AddrNotAvailable
            | ErrorKind::NetworkUnreachable
            | ErrorKind::HostUnreachable
            | ErrorKind::Unsupported
    )
}

/// IPv4 first; IPv6 whenever IPv4 fails (dev servers often bind only `::1` for `localhost`).
/// "Refused" only when IPv4 refused and IPv6 refused too (or the host has no IPv6 loopback).
async fn dial(targets: [SocketAddr; 2]) -> Result<TcpStream, (DeviceLoopbackFailure, String)> {
    let [v4, v6] = targets;
    let v4_refused = match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(v4)).await {
        Ok(Ok(stream)) => return Ok(stream),
        Ok(Err(error)) => error.kind() == ErrorKind::ConnectionRefused,
        Err(_) => false,
    };
    match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(v6)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error))
            if v4_refused
                && (error.kind() == ErrorKind::ConnectionRefused
                    || unavailable_family(error.kind())) =>
        {
            Err((
                DeviceLoopbackFailure::Refused,
                format!("nothing listens on loopback port {}", v4.port()),
            ))
        }
        Ok(Err(error)) => Err((
            DeviceLoopbackFailure::Unreachable,
            format!("loopback port {}: {error}", v4.port()),
        )),
        Err(_) => Err((
            DeviceLoopbackFailure::Unreachable,
            format!("loopback port {}: dial timed out", v4.port()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct FakeOutlet {
        sent: Mutex<Vec<Payload>>,
        reject_data: AtomicBool,
        reject_all: AtomicBool,
        channel_closed: AtomicBool,
    }

    impl Outlet for FakeOutlet {
        fn send(&self, payload: Payload) -> bool {
            if self.reject_all.load(Ordering::Acquire)
                || (self.reject_data.load(Ordering::Acquire)
                    && matches!(payload, Payload::LoopbackData(_)))
            {
                return false;
            }
            self.sent.lock().unwrap().push(payload);
            true
        }
        fn close_channel(&self) {
            self.channel_closed.store(true, Ordering::Release);
        }
    }

    impl FakeOutlet {
        fn take(&self) -> Vec<Payload> {
            std::mem::take(&mut *self.sent.lock().unwrap())
        }
        fn data_frames(&self) -> Vec<(u32, Vec<u8>)> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .filter_map(|payload| match payload {
                    Payload::LoopbackData(data) => Some((data.connection_id, data.data.clone())),
                    _ => None,
                })
                .collect()
        }
    }

    fn table(limits: Limits) -> (LoopbackTable, Arc<FakeOutlet>, Arc<AtomicUsize>) {
        let outlet = Arc::new(FakeOutlet::default());
        let counter = Arc::new(AtomicUsize::new(0));
        let table = LoopbackTable::with_limits(outlet.clone(), counter.clone(), limits);
        (table, outlet, counter)
    }

    fn open(handle: &LoopbackHandle, connection_id: u32, port: u32) {
        handle.dispatch(Payload::LoopbackOpen(DeviceLoopbackOpen {
            connection_id,
            port,
        }));
    }

    async fn eventually(mut check: impl FnMut() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached in time");
    }

    /// Settle long enough that a misbehaving sender would have overshot.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    async fn free_port() -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        listener.local_addr().unwrap().port()
    }

    fn failure_of(payloads: &[Payload], connection_id: u32) -> Option<DeviceLoopbackFailure> {
        payloads.iter().find_map(|payload| match payload {
            Payload::LoopbackFailed(failed) if failed.connection_id == connection_id => {
                DeviceLoopbackFailure::try_from(failed.reason).ok()
            }
            _ => None,
        })
    }

    fn has(payloads: &[Payload], predicate: impl Fn(&Payload) -> bool) -> bool {
        payloads.iter().any(predicate)
    }

    #[test]
    fn targets_are_only_the_loopback_addresses_of_the_port() {
        let [v4, v6] = dial_targets(5173).unwrap();
        assert_eq!(v4, "127.0.0.1:5173".parse::<SocketAddr>().unwrap());
        assert_eq!(v6, "[::1]:5173".parse::<SocketAddr>().unwrap());
        assert!(v4.ip().is_loopback() && v6.ip().is_loopback());
        assert!(dial_targets(0).is_none());
        assert!(dial_targets(65_536).is_none());
        assert!(dial_targets(u32::MAX).is_none());
        assert!(dial_targets(1).is_some() && dial_targets(65_535).is_some());
    }

    #[tokio::test]
    async fn invalid_port_and_id_fail_without_dialing() {
        let (table, outlet, counter) = table(Limits::default());
        let handle = table.handle();
        open(&handle, 1, 0);
        open(&handle, 2, 70_000);
        open(&handle, 0, 80);
        let sent = outlet.take();
        assert_eq!(failure_of(&sent, 1), Some(DeviceLoopbackFailure::Invalid));
        assert_eq!(failure_of(&sent, 2), Some(DeviceLoopbackFailure::Invalid));
        assert_eq!(failure_of(&sent, 0), Some(DeviceLoopbackFailure::Invalid));
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn nothing_listening_is_reported_as_refused() {
        let (table, outlet, counter) = table(Limits::default());
        let port = free_port().await;
        open(&table.handle(), 7, port as u32);
        eventually(|| failure_of(&outlet.sent.lock().unwrap(), 7).is_some()).await;
        assert_eq!(
            failure_of(&outlet.take(), 7),
            Some(DeviceLoopbackFailure::Refused)
        );
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn ipv6_only_listener_is_reached_through_the_fallback() {
        let Ok(listener) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await else {
            return; // No IPv6 loopback on this host.
        };
        let port = listener.local_addr().unwrap().port();
        if TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_ok() {
            return; // Something else owns the IPv4 side of this port.
        }
        let (table, outlet, _) = table(Limits::default());
        open(&table.handle(), 3, port as u32);
        let (_socket, _) = listener.accept().await.unwrap();
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackOpened(opened) if opened.connection_id == 3)
            })
        })
        .await;
    }

    #[tokio::test]
    async fn bytes_flow_both_ways_in_order_and_client_close_flushes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, counter) = table(Limits::default());
        let handle = table.handle();
        open(&handle, 1, port as u32);
        let (mut socket, _) = listener.accept().await.unwrap();
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackOpened(_))
            })
        })
        .await;
        for chunk in [b"GET / HTTP/1.1\r\n".as_slice(), b"Host: localhost\r\n\r\n"] {
            handle.dispatch(Payload::LoopbackData(DeviceLoopbackData {
                connection_id: 1,
                data: chunk.to_vec(),
            }));
        }
        handle.dispatch(Payload::LoopbackClose(DeviceLoopbackClose { connection_id: 1 }));
        let mut received = Vec::new();
        socket.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
        eventually(|| counter.load(Ordering::Acquire) == 0).await;
        let sent = outlet.take();
        let acked: u32 = sent
            .iter()
            .filter_map(|payload| match payload {
                Payload::LoopbackAck(ack) if ack.connection_id == 1 => Some(ack.frames),
                _ => None,
            })
            .sum();
        assert_eq!(acked, 2, "every written client frame is acknowledged");
        assert!(
            !has(&sent, |payload| matches!(payload, Payload::LoopbackClose(_))),
            "a client-initiated close is not echoed"
        );
    }

    #[tokio::test]
    async fn device_side_eof_arrives_after_all_data() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, _) = table(Limits::default());
        open(&table.handle(), 9, port as u32);
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.write_all(b"hello from the device").await.unwrap();
        drop(socket);
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackClose(close) if close.connection_id == 9)
            })
        })
        .await;
        let sent = outlet.take();
        let close_at = sent
            .iter()
            .position(|payload| matches!(payload, Payload::LoopbackClose(_)))
            .unwrap();
        let data: Vec<u8> = sent[..close_at]
            .iter()
            .filter_map(|payload| match payload {
                Payload::LoopbackData(data) => Some(data.data.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(data, b"hello from the device");
    }

    /// A device-side writer that floods its socket as fast as the tunnel lets it.
    async fn flood(listener: TcpListener, connections: usize) -> Vec<tokio::task::JoinHandle<()>> {
        let mut writers = Vec::new();
        for _ in 0..connections {
            let (mut socket, _) = listener.accept().await.unwrap();
            writers.push(tokio::spawn(async move {
                let chunk = vec![7u8; FRAME_BYTES];
                while socket.write_all(&chunk).await.is_ok() {}
            }));
        }
        writers
    }

    #[tokio::test]
    async fn a_connection_never_exceeds_its_window_until_acknowledged() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, _) = table(Limits::default());
        let handle = table.handle();
        open(&handle, 1, port as u32);
        let writers = flood(listener, 1).await;
        eventually(|| outlet.data_frames().len() == CONNECTION_WINDOW_FRAMES).await;
        settle().await;
        assert_eq!(outlet.data_frames().len(), CONNECTION_WINDOW_FRAMES);
        handle.dispatch(Payload::LoopbackAck(DeviceLoopbackAck {
            connection_id: 1,
            frames: 3,
        }));
        eventually(|| outlet.data_frames().len() == CONNECTION_WINDOW_FRAMES + 3).await;
        settle().await;
        assert_eq!(outlet.data_frames().len(), CONNECTION_WINDOW_FRAMES + 3);
        // An inflated acknowledgement cannot mint credit beyond what is outstanding.
        handle.dispatch(Payload::LoopbackAck(DeviceLoopbackAck {
            connection_id: 1,
            frames: 1_000,
        }));
        eventually(|| outlet.data_frames().len() == 2 * CONNECTION_WINDOW_FRAMES + 3).await;
        settle().await;
        assert_eq!(outlet.data_frames().len(), 2 * CONNECTION_WINDOW_FRAMES + 3);
        for writer in writers {
            writer.abort();
        }
    }

    #[tokio::test]
    async fn the_channel_never_has_more_than_its_aggregate_window_in_flight() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, _) = table(Limits::default());
        let handle = table.handle();
        let connections = 10; // 10 × 8 per-connection credit is well above the channel cap.
        for id in 1..=connections {
            open(&handle, id, port as u32);
        }
        let writers = flood(listener, connections as usize).await;
        eventually(|| outlet.data_frames().len() == CHANNEL_WINDOW_FRAMES).await;
        settle().await;
        assert_eq!(outlet.data_frames().len(), CHANNEL_WINDOW_FRAMES);
        // Acknowledging frames of a connection releases exactly that much channel credit.
        let (first, _) = outlet.data_frames()[0].clone();
        handle.dispatch(Payload::LoopbackAck(DeviceLoopbackAck {
            connection_id: first,
            frames: 2,
        }));
        eventually(|| outlet.data_frames().len() == CHANNEL_WINDOW_FRAMES + 2).await;
        settle().await;
        assert_eq!(outlet.data_frames().len(), CHANNEL_WINDOW_FRAMES + 2);
        for writer in writers {
            writer.abort();
        }
    }

    #[tokio::test]
    async fn acknowledging_a_closed_connection_still_returns_channel_credit() {
        let limits = Limits {
            channel_window: 2,
            ..Limits::default()
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, counter) = table(limits);
        let handle = table.handle();
        open(&handle, 1, port as u32);
        let writers = flood(listener, 1).await;
        eventually(|| outlet.data_frames().len() == 2).await;
        // The client closes the connection before acknowledging what it received.
        handle.dispatch(Payload::LoopbackClose(DeviceLoopbackClose { connection_id: 1 }));
        eventually(|| counter.load(Ordering::Acquire) == 0).await;
        for writer in writers {
            writer.abort();
        }
        assert_eq!(table.inner.lane_credit.available_permits(), 0);
        handle.dispatch(Payload::LoopbackAck(DeviceLoopbackAck {
            connection_id: 1,
            frames: 2,
        }));
        assert_eq!(table.inner.lane_credit.available_permits(), 2);
        assert_eq!(*table.inner.lane_outstanding.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_frame_the_channel_cannot_queue_closes_the_connection() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, counter) = table(Limits::default());
        open(&table.handle(), 4, port as u32);
        let (mut socket, _) = listener.accept().await.unwrap();
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackOpened(_))
            })
        })
        .await;
        outlet.reject_data.store(true, Ordering::Release);
        socket.write_all(b"lost?").await.unwrap();
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackClose(close) if close.connection_id == 4)
            })
        })
        .await;
        assert!(outlet.data_frames().is_empty(), "no partial stream is sent");
        let mut rest = Vec::new();
        let _ = socket.read_to_end(&mut rest).await;
        eventually(|| counter.load(Ordering::Acquire) == 0).await;
        assert!(!outlet.channel_closed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn when_even_the_close_cannot_be_queued_the_channel_closes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, _) = table(Limits::default());
        open(&table.handle(), 4, port as u32);
        let (mut socket, _) = listener.accept().await.unwrap();
        eventually(|| {
            has(&outlet.sent.lock().unwrap(), |payload| {
                matches!(payload, Payload::LoopbackOpened(_))
            })
        })
        .await;
        outlet.reject_all.store(true, Ordering::Release);
        socket.write_all(b"x").await.unwrap();
        eventually(|| outlet.channel_closed.load(Ordering::Acquire)).await;
    }

    #[tokio::test]
    async fn overrunning_the_client_window_closes_the_connection() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, counter) = table(Limits::default());
        let handle = table.handle();
        open(&handle, 5, port as u32);
        // Dispatch is synchronous: on this single-threaded runtime the connection task cannot
        // drain its queue between these calls, so the ninth frame overruns the window.
        for _ in 0..=CLIENT_CONNECTION_WINDOW_FRAMES {
            handle.dispatch(Payload::LoopbackData(DeviceLoopbackData {
                connection_id: 5,
                data: b"x".to_vec(),
            }));
        }
        let sent = outlet.take();
        assert!(has(&sent, |payload| {
            matches!(payload, Payload::LoopbackClose(close) if close.connection_id == 5)
        }));
        assert_eq!(counter.load(Ordering::Acquire), 0);
        drop(listener);
    }

    #[tokio::test]
    async fn oversized_client_frame_closes_the_connection() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, _) = table(Limits::default());
        let handle = table.handle();
        open(&handle, 6, port as u32);
        handle.dispatch(Payload::LoopbackData(DeviceLoopbackData {
            connection_id: 6,
            data: vec![0; FRAME_BYTES + 1],
        }));
        assert!(has(&outlet.take(), |payload| {
            matches!(payload, Payload::LoopbackClose(close) if close.connection_id == 6)
        }));
    }

    #[tokio::test]
    async fn connection_caps_are_enforced_per_channel_and_per_worker() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port() as u32;
        let limits = Limits {
            channel_connections: 2,
            worker_connections: 3,
            ..Limits::default()
        };
        let outlet_a = Arc::new(FakeOutlet::default());
        let outlet_b = Arc::new(FakeOutlet::default());
        let counter = Arc::new(AtomicUsize::new(0));
        let a = LoopbackTable::with_limits(outlet_a.clone(), counter.clone(), limits);
        let b = LoopbackTable::with_limits(outlet_b.clone(), counter.clone(), limits);
        for id in 1..=3 {
            open(&a.handle(), id, port);
        }
        assert_eq!(
            failure_of(&outlet_a.take(), 3),
            Some(DeviceLoopbackFailure::Limit)
        );
        open(&b.handle(), 1, port);
        open(&b.handle(), 2, port);
        assert_eq!(
            failure_of(&outlet_b.take(), 2),
            Some(DeviceLoopbackFailure::Limit)
        );
        assert_eq!(counter.load(Ordering::Acquire), 3);
        // A duplicate id never disturbs the live connection that owns it.
        open(&a.handle(), 1, port);
        assert_eq!(
            failure_of(&outlet_a.take(), 1),
            Some(DeviceLoopbackFailure::Invalid)
        );
        assert_eq!(counter.load(Ordering::Acquire), 3);
        drop(a);
        assert_eq!(counter.load(Ordering::Acquire), 1);
        drop(b);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn dropping_the_table_closes_every_connection() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (table, outlet, counter) = table(Limits::default());
        open(&table.handle(), 1, port as u32);
        open(&table.handle(), 2, port as u32);
        let (mut first, _) = listener.accept().await.unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        eventually(|| {
            outlet
                .sent
                .lock()
                .unwrap()
                .iter()
                .filter(|payload| matches!(payload, Payload::LoopbackOpened(_)))
                .count()
                == 2
        })
        .await;
        drop(table);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), first.read_to_end(&mut rest))
            .await
            .expect("first socket closes")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), second.read_to_end(&mut rest))
            .await
            .expect("second socket closes")
            .unwrap();
    }
}
