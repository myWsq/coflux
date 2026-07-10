//! PTY 会话生命周期（活在 supervisor）。持有 portable-pty + scrollback；
//! 输出/事件经 outbound 通道发给 worker（UDS）。背压 = 全局暂停读线程，让 OS 管道回压子进程
//! （复刻 node-pty 的 pause 语义）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use coflux_protocol::{encode_frame, write_record, DataFrame, SessionInfo, SupervisorToWorker};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    task_id: String,
    pid: i32,
    scrollback: Vec<u8>,
}

/// 全局背压闸：true=暂停全部 PTY 读线程
pub type Pause = Arc<(Mutex<bool>, Condvar)>;

pub struct Sessions {
    map: Mutex<HashMap<String, Session>>,
    outbound: Mutex<Sender<Vec<u8>>>, // mpsc::Sender 非 Sync，用 Mutex 包一层以便跨线程共享
    pause: Pause,
    shell: String,
    home: String,
    scrollback_limit: usize,
}

impl Sessions {
    pub fn new(outbound: Sender<Vec<u8>>, pause: Pause, shell: String, home: String, scrollback_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            outbound: Mutex::new(outbound),
            pause,
            shell,
            home,
            scrollback_limit,
        })
    }

    fn send_record(&self, rec: Vec<u8>) {
        let _ = self.outbound.lock().unwrap().send(rec);
    }
    fn send_ctrl(&self, msg: &SupervisorToWorker) {
        if let Ok(bytes) = serde_json::to_vec(msg) {
            self.send_record(write_record(&bytes));
        }
    }

    pub fn create(self: &Arc<Self>, session_id: String, task_id: String, cwd: String, shell: String, cols: u16, rows: u16) {
        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
            Ok(p) => p,
            Err(e) => return self.fail(&session_id, &format!("openpty: {e}")),
        };
        let shell = if shell.is_empty() { self.shell.clone() } else { shell };
        let cwd = if cwd.is_empty() { self.home.clone() } else { cwd };
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => return self.fail(&session_id, &format!("spawn: {e}")),
        };
        drop(pair.slave); // 让子进程退出时 master 读到 EOF
        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => return self.fail(&session_id, &format!("clone_reader: {e}")),
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => return self.fail(&session_id, &format!("take_writer: {e}")),
        };
        let pid = child.process_id().map(|p| p as i32).unwrap_or(-1);
        self.map.lock().unwrap().insert(
            session_id.clone(),
            Session { master: pair.master, writer, child, task_id: task_id.clone(), pid, scrollback: Vec::new() },
        );
        eprintln!("[supervisor] session started {session_id} pid={pid}");
        self.send_ctrl(&SupervisorToWorker::SessionStarted { session_id: session_id.clone(), task_id, pid });
        self.spawn_reader(session_id, reader);
    }

    fn fail(&self, session_id: &str, why: &str) {
        eprintln!("[supervisor] session create failed {session_id}: {why}");
        self.send_ctrl(&SupervisorToWorker::SessionExit { session_id: session_id.to_string(), exit_code: -1 });
    }

    fn spawn_reader(self: &Arc<Self>, session_id: String, mut reader: Box<dyn Read + Send>) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                {
                    let (lock, cvar) = &*this.pause;
                    let mut paused = lock.lock().unwrap();
                    while *paused {
                        paused = cvar.wait(paused).unwrap();
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        {
                            let mut map = this.map.lock().unwrap();
                            match map.get_mut(&session_id) {
                                Some(s) => {
                                    s.scrollback.extend_from_slice(chunk);
                                    let len = s.scrollback.len();
                                    if len > this.scrollback_limit {
                                        s.scrollback.drain(0..len - this.scrollback_limit);
                                    }
                                }
                                None => break,
                            }
                        }
                        let frame = encode_frame(&DataFrame::Output { session_id: session_id.clone(), data: chunk.to_vec() });
                        this.send_record(write_record(&frame));
                    }
                }
            }
            // 会话结束：摘除、取退出码、上报 SessionExit
            let removed = this.map.lock().unwrap().remove(&session_id);
            if let Some(mut s) = removed {
                let code = s.child.wait().map(|st| st.exit_code() as i32).unwrap_or(-1);
                eprintln!("[supervisor] session exited {session_id} code={code}");
                this.send_ctrl(&SupervisorToWorker::SessionExit { session_id, exit_code: code });
            }
        });
    }

    pub fn input(&self, session_id: &str, data: &[u8]) {
        if let Some(s) = self.map.lock().unwrap().get_mut(session_id) {
            let _ = s.writer.write_all(data);
        }
    }
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.map.lock().unwrap().get(session_id) {
            let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    pub fn close(&self, session_id: &str) {
        // 杀子进程 → 读线程读到 EOF，统一在那里摘除并上报 SessionExit
        if let Some(s) = self.map.lock().unwrap().get_mut(session_id) {
            let _ = s.child.kill();
        }
    }
    pub fn replay(&self, session_id: &str, request_id: String) {
        let sb = self.map.lock().unwrap().get(session_id).map(|s| s.scrollback.clone()).unwrap_or_default();
        let frame = encode_frame(&DataFrame::Replay { session_id: session_id.to_string(), request_id, data: sb });
        self.send_record(write_record(&frame));
    }
    pub fn send_resync(&self) {
        let sessions: Vec<SessionInfo> = self
            .map
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| SessionInfo { session_id: id.clone(), task_id: s.task_id.clone(), pid: s.pid })
            .collect();
        self.send_ctrl(&SupervisorToWorker::ResyncList { sessions });
    }
    pub fn set_pause(&self, val: bool) {
        let (lock, cvar) = &*self.pause;
        let mut p = lock.lock().unwrap();
        *p = val;
        if !val {
            cvar.notify_all();
        }
    }
    pub fn shutdown(&self) {
        for s in self.map.lock().unwrap().values_mut() {
            let _ = s.child.kill();
        }
    }
}
