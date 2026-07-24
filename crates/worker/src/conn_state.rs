//! 连接状态落盘（$COFLUX_HOME/conn-state.json）。
//!
//! 事故背景（plan 033）：`cofluxd status` 此前只查 launchd/systemd 进程存活就报"运行中"，
//! 进程活着但 worker 早已挂在一条半死连接上没人知道。这里把 worker 自己看到的连接状态
//! （而非"进程还在跑"）落成一个小文件，供 CLI 展示真实在线态。
//!
//! 三态：connecting（启动后从未 authed 过，仍在首次连接）｜connected（已 authed）｜
//! reconnecting（曾经 authed 过，现在连接断了，正在重试）。`connected` 的判定是收到
//! DaemonAuthed/DaemonEnrolled（认证通过），不是 TCP 连上——TCP 通了但没过认证对用户
//! 而言仍不可用。纯本地快照文件，不含密钥，无需 0600。

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Serialize)]
struct ConnStateFile {
    state: &'static str,
    since: u64,
    #[serde(rename = "lastAuthed", skip_serializing_if = "Option::is_none")]
    last_authed: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct ConnState {
    path: String,
    current: &'static str, // 空串 = 尚未写过文件（构造后第一次 set 必然触发写）
    since_ms: u64,
    last_authed_ms: Option<u64>,
}

impl ConnState {
    pub fn new(home: &str) -> Self {
        Self { path: format!("{home}/conn-state.json"), current: "", since_ms: 0, last_authed_ms: None }
    }

    fn set(&mut self, state: &'static str) {
        if self.current != state {
            self.current = state;
            self.since_ms = now_ms();
        }
        self.flush();
    }

    fn flush(&self) {
        let file = ConnStateFile { state: self.current, since: self.since_ms, last_authed: self.last_authed_ms };
        if let Ok(json) = serde_json::to_string_pretty(&file) {
            let _ = fs::write(&self.path, json);
        }
    }

    /// 启动后首次连接、以及"从未成功 authed 过"期间的重试，都展示为 connecting
    /// （用户视角这是"第一次连上"，不是"掉线重连"）。
    pub fn connecting(&mut self) {
        self.set("connecting");
    }

    /// 收到 DaemonAuthed/DaemonEnrolled：连接真正可用。
    pub fn connected(&mut self) {
        self.last_authed_ms = Some(now_ms());
        self.set("connected");
    }

    /// 连接断开、准备重试：曾经 authed 过才算"重连"，否则仍是 connecting（见上）。
    pub fn reconnecting(&mut self) {
        if self.last_authed_ms.is_none() {
            self.set("connecting");
        } else {
            self.set("reconnecting");
        }
    }
}
