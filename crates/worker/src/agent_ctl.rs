//! agent 协同控制端点（plan 074）：跑在 coflux PTY 里的 claude/codex 经
//! `cofluxd terminal|notify|ports` 把自己的工作外化成用户在 web/手机上**看得见、能接管**的
//! coflux 实体——而不是在自己的 Bash 里后台起一个谁也看不见的进程。
//!
//! **身份不靠凭证靠位置**：调用方把自己的 pid 报上来，worker 反查它落在哪个存活 session 的
//! 进程树内（[`agents::session_of_pid`]）。树外 pid 一律拒——这既是身份也是权限边界：只有
//! coflux 自己起的 PTY 里的进程能进来，本机其它进程（含被网页驱动的本地程序）都进不来，
//! 而且能力天然被钉死在「发起方所属的那个 session」上。agent 侧因此不需要任何凭证。
//!
//! **本地能闭环的不碰中心（plan 094）**：send / read / wait(status) / notify / progress 全在 daemon
//! 本地完成——归属校验（目标与调用方同工作区）与退出码来自 [`crate::session_ledger`]，内容来自
//! 本地命令日志或 sessiond 快照，presence 标注改 observed 后立即上报（断连期间由重连后的全量补发
//! 兜底）。它们不要求 daemon 此刻连着中心。只有 new / list / ports 转成 `AgentControlRequest` 交给
//! 中心：Task 要落库广播、预览 URL 由中心生成，这三条本来就不是本地能闭环的；中心离线时它们明确
//! 报错——「让用户看得见」正是它们的全部意义。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::wire::{
    self, agent_control_request, agent_control_result, daemon_to_server, server_agent_request,
    server_agent_result,
};
use tokio::sync::{mpsc, oneshot};

use prost::Message as _;

use crate::session_ledger::{SessionPhase, SessionRecord};
use crate::{agents, device::DeviceRuntime, observed::ObservedState, ops, WorkerState, WsOut};

/// 等中心回执的上限：只防在飞请求永久占住 pending 表，CLI 侧自己的超时更短。
const SERVER_TIMEOUT: Duration = Duration::from_secs(20);
/// notify 留言长度上限（字符）。它只是侧栏 tooltip 里的一句话，不是日志通道。
const MAX_NOTIFY_CHARS: usize = 200;
/// 单次 read 从命令日志尾部取的字节上限；CLI 侧还会再按行数收窄。
const MAX_LOG_TAIL_BYTES: u64 = 256 * 1024;
/// agent_logs 表的条目上限。超出即整表清空——丢失只意味着 read 退回中心 checkpoint，
/// 没有正确性后果，所以不值得为它做 LRU。
/// ponytail: 粗暴清表，真出现「一个工作区几百个终端」的用法再换 LRU。
const MAX_TRACKED_LOGS: usize = 256;
/// 中心回执关联表只保存正在等待的 agent 控制请求；达到上限立即拒绝，不能让本地 HTTP
/// 并发在 20 秒超时窗口内无界堆积。
const AGENT_PENDING_LIMIT: usize = 128;

/// 单次 ServerTerminalRead 回给中心的字节上限（worker 侧钳制；中心再按行数收窄，与 checkpoint 同级）。
const MAX_SERVER_READ_BYTES: u64 = 256 * 1024;
/// ServerTerminalInput 单次写入字节上限：MCP 一次 send 是一行命令或一小段文本，不是文件通道。
const MAX_SERVER_INPUT_BYTES: usize = 64 * 1024;

pub(crate) fn remember_log(state: &Arc<Mutex<WorkerState>>, task_id: String, log_path: String) {
    let mut s = state.lock().unwrap();
    if s.agent_logs.len() >= MAX_TRACKED_LOGS {
        s.agent_logs.clear();
    }
    s.agent_logs.insert(task_id, log_path);
}

/// gateway 解析出的一条 agent 控制请求；`respond` 回填 HTTP 应答。
pub struct AgentRequest {
    pub pid: i32,
    pub ppid: i32,
    pub action: AgentAction,
    pub respond: oneshot::Sender<AgentResponse>,
}

pub enum AgentAction {
    TerminalNew {
        title: String,
        command: String,
    },
    TerminalList,
    TerminalRead {
        task_id: String,
    },
    /// `terminal wait` 的轮询原语：只回 status/exitCode，本地账本直接答
    TerminalStatus {
        task_id: String,
    },
    TerminalSend {
        task_id: String,
        text: String,
        enter: bool,
    },
    Notify {
        message: String,
    },
    Progress {
        message: String,
    },
    Ports,
}

pub struct AgentResponse {
    /// HTTP status line，如 "200 OK"
    pub status: &'static str,
    /// JSON 响应体
    pub body: String,
}

impl AgentResponse {
    pub(crate) fn ok(payload: serde_json::Value) -> Self {
        let mut object = serde_json::Map::new();
        object.insert("ok".into(), serde_json::Value::Bool(true));
        if let serde_json::Value::Object(fields) = payload {
            object.extend(fields);
        }
        Self {
            status: "200 OK",
            body: serde_json::Value::Object(object).to_string(),
        }
    }

    pub(crate) fn err(status: &'static str, message: impl AsRef<str>) -> Self {
        let body = serde_json::json!({ "ok": false, "error": message.as_ref() });
        Self {
            status,
            body: body.to_string(),
        }
    }
}

/// request_id 的进程内序号；与 pid 一起构成本 daemon 内唯一的关联键（server 只用它做响应
/// 关联，不承担幂等——见 daemon.proto 里 AgentControlRequest 的契约注释）。
static NEXT_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_request_id() -> String {
    format!(
        "agent-{}-{}",
        std::process::id(),
        NEXT_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn try_insert_agent_pending(
    pending: &mut HashMap<String, oneshot::Sender<wire::AgentControlResult>>,
    request_id: String,
    waiter: oneshot::Sender<wire::AgentControlResult>,
) -> bool {
    if pending.len() >= AGENT_PENDING_LIMIT || pending.contains_key(&request_id) {
        return false;
    }
    pending.insert(request_id, waiter);
    true
}

/// 消费循环：每条请求先过 pid 身份门，再按动作分派。
pub async fn consume_agent_requests(
    mut rx: mpsc::Receiver<AgentRequest>,
    state: Arc<Mutex<WorkerState>>,
    observed: Arc<ObservedState>,
    to_server_tx: mpsc::Sender<WsOut>,
    device: Arc<DeviceRuntime>,
) {
    while let Some(request) = rx.recv().await {
        let state = state.clone();
        let observed = observed.clone();
        let to_server_tx = to_server_tx.clone();
        let device = device.clone();
        // 每条请求独立任务：terminal.* 要等中心回执（最长 SERVER_TIMEOUT），不能阻塞后续请求。
        tokio::spawn(async move {
            let response = handle(
                &state,
                &observed,
                &to_server_tx,
                &device,
                request.pid,
                request.ppid,
                request.action,
            )
            .await;
            let _ = request.respond.send(response);
        });
    }
}

async fn handle(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &mpsc::Sender<WsOut>,
    device: &Arc<DeviceRuntime>,
    pid: i32,
    ppid: i32,
    action: AgentAction,
) -> AgentResponse {
    let alive = { state.lock().unwrap().alive.clone() };
    let session_id = tokio::task::spawn_blocking(move || agents::session_of_pid(&alive, pid, ppid))
        .await
        .ok()
        .flatten();
    let Some(session_id) = session_id else {
        return AgentResponse::err(
            "403 Forbidden",
            "不在 coflux 终端里：本命令只能由 coflux 会话内的进程调用",
        );
    };

    match action {
        AgentAction::Notify { message } => {
            let message: String = message.chars().take(MAX_NOTIFY_CHARS).collect();
            observed.apply_notify(session_id, message);
            crate::report_agents_if_changed(state, observed, to_server_tx).await;
            AgentResponse::ok(serde_json::json!({}))
        }
        AgentAction::Progress { message } => {
            // 与 notify 是两条信道：progress 只播报进度，不改 state、不置 question，
            // 且跨 hook 事件存活（只被下一条覆盖）。同为 daemon 本地闭环。
            let message: String = message.chars().take(MAX_NOTIFY_CHARS).collect();
            observed.apply_progress(session_id, message);
            crate::report_agents_if_changed(state, observed, to_server_tx).await;
            AgentResponse::ok(serde_json::json!({}))
        }
        AgentAction::TerminalNew { title, command } => {
            let (shell, log_path) = match ops::write_command_script(&command) {
                Ok(paths) => paths,
                Err(error) => {
                    return AgentResponse::err(
                        "500 Internal Server Error",
                        format!("写命令脚本失败：{error}"),
                    )
                }
            };
            let payload = agent_control_request::Payload::TerminalNew(wire::AgentTerminalNew {
                title,
                shell,
            });
            match ask_server(state, to_server_tx, session_id, payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::TerminalNew(result)) => {
                    remember_log(state, result.task_id.clone(), log_path);
                    AgentResponse::ok(
                        serde_json::json!({ "taskId": result.task_id, "sessionId": result.session_id }),
                    )
                }
                Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
            }
        }
        AgentAction::TerminalList => {
            let payload = agent_control_request::Payload::TerminalList(wire::AgentTerminalList {});
            match ask_server(state, to_server_tx, session_id, payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::TerminalList(result)) => {
                    let terminals: Vec<serde_json::Value> = result
                        .terminals
                        .into_iter()
                        .map(|terminal| {
                            serde_json::json!({
                                "taskId": terminal.task_id,
                                "title": terminal.title,
                                "status": status_name(terminal.status),
                                "exitCode": terminal.exit_code,
                                "sessionId": terminal.session_id,
                                "createdAt": terminal.created_at,
                            })
                        })
                        .collect();
                    AgentResponse::ok(serde_json::json!({ "terminals": terminals }))
                }
                Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
            }
        }
        AgentAction::TerminalRead { task_id } => {
            // 本地闭环（plan 094）：归属与状态来自会话账本，内容优先本地命令日志尾部；会话仍活着
            // 则退回 sessiond 当前快照；都没有则为空。不问中心——agent 就跑在这台 daemon 上，中心
            // checkpoint 只是这里的派生缓存。ANSI 原样带回，去转义在 CLI 侧做。
            let (target_session, record) =
                match resolve_local_target(state, &session_id, &task_id) {
                    Ok(found) => found,
                    Err(response) => return response,
                };
            let local_log = { state.lock().unwrap().agent_logs.get(&task_id).cloned() };
            let from_log = local_log
                .as_deref()
                .and_then(|path| ops::read_command_log_tail(path, MAX_LOG_TAIL_BYTES));
            let text = match from_log {
                Some(text) => text,
                None if record.phase == SessionPhase::Running => device
                    .read_session_snapshot(&target_session)
                    .await
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default(),
                None => String::new(),
            };
            AgentResponse::ok(serde_json::json!({
                "ansi": text,
                "capturedAt": epoch_ms(),
                "status": phase_name(&record.phase),
                "exitCode": exit_code_of(&record.phase),
            }))
        }
        AgentAction::TerminalStatus { task_id } => {
            match resolve_local_target(state, &session_id, &task_id) {
                Ok((_, record)) => AgentResponse::ok(serde_json::json!({
                    "taskId": task_id,
                    "status": phase_name(&record.phase),
                    "exitCode": exit_code_of(&record.phase),
                })),
                Err(response) => response,
            }
        }
        AgentAction::TerminalSend {
            task_id,
            text,
            enter,
        } => {
            // 归属本地判定（plan 094），写入本身走 sessiond 正门（见 DeviceRuntime::agent_send_input
            // 的契约注释）：人类 holder 在场即拒。中心不在路径上。
            let (target_session, record) =
                match resolve_local_target(state, &session_id, &task_id) {
                    Ok(found) => found,
                    Err(response) => return response,
                };
            match record.phase {
                SessionPhase::Exited { .. } => {
                    return AgentResponse::err(
                        "409 Conflict",
                        "终端已退出，不能再输入（要跑新命令用 cofluxd terminal new）",
                    )
                }
                SessionPhase::Pending => {
                    return AgentResponse::err("409 Conflict", "终端尚未就绪，稍后重试")
                }
                SessionPhase::Running => {}
            }
            let mut data = text.into_bytes();
            if enter {
                data.push(b'\r');
            }
            match device.agent_send_input(&target_session, data).await {
                Ok(()) => AgentResponse::ok(serde_json::json!({})),
                Err(message) => AgentResponse::err("409 Conflict", message),
            }
        }
        AgentAction::Ports => {
            let payload = agent_control_request::Payload::PortsList(wire::AgentPortsList {});
            match ask_server(state, to_server_tx, session_id, payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::PortsList(result)) => {
                    let ports: Vec<serde_json::Value> = result
                        .ports
                        .into_iter()
                        .map(|preview| serde_json::json!({ "port": preview.port, "url": preview.url }))
                        .collect();
                    AgentResponse::ok(serde_json::json!({ "ports": ports }))
                }
                Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
            }
        }
    }
}

/// 本地命令的目标解析（plan 094）：调用方与目标都必须有已知归属且同工作区。归属只认中心随
/// SessionCreate 下发的 workspace_id；早于 daemon 升级的会话归属未知，一律可读拒绝，不按 cwd 猜。
/// 「不在本工作区」与「不存在」同一句错误——不向别的工作区泄漏存在性。
fn resolve_local_target(
    state: &Arc<Mutex<WorkerState>>,
    caller_session: &str,
    task_id: &str,
) -> Result<(String, SessionRecord), AgentResponse> {
    let s = state.lock().unwrap();
    let Some(caller) = s.ledger.session(caller_session) else {
        return Err(AgentResponse::err(
            "409 Conflict",
            "本终端早于 daemon 升级，缺少工作区归属：重开终端后再用本地命令",
        ));
    };
    if caller.workspace_id.is_empty() {
        return Err(AgentResponse::err(
            "409 Conflict",
            "本终端早于 daemon 升级，缺少工作区归属：重开终端后再用本地命令",
        ));
    }
    let not_found = || {
        AgentResponse::err(
            "404 Not Found",
            "终端不在本工作区或不存在（用 cofluxd terminal list 查）",
        )
    };
    let Some((target_session, target)) = s.ledger.task(task_id) else {
        return Err(not_found());
    };
    if target.workspace_id.is_empty() {
        return Err(AgentResponse::err(
            "409 Conflict",
            "目标终端早于 daemon 升级，缺少工作区归属：重开它后再试",
        ));
    }
    if target.workspace_id != caller.workspace_id {
        return Err(not_found());
    }
    Ok((target_session.to_string(), target.clone()))
}

fn phase_name(phase: &SessionPhase) -> &'static str {
    match phase {
        SessionPhase::Pending => "idle",
        SessionPhase::Running => "running",
        SessionPhase::Exited { .. } => "exited",
    }
}

fn exit_code_of(phase: &SessionPhase) -> Option<i32> {
    match phase {
        SessionPhase::Exited { exit_code } => Some(*exit_code),
        _ => None,
    }
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 发一条 AgentControlRequest 并等中心回执。失败路径全部转成给 agent 看的 HTTP 错误。
async fn ask_server(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &mpsc::Sender<WsOut>,
    session_id: String,
    payload: agent_control_request::Payload,
) -> Result<agent_control_result::Payload, AgentResponse> {
    let request_id = next_request_id();
    let (tx, rx) = oneshot::channel();
    {
        let mut s = state.lock().unwrap();
        if !s.authed {
            return Err(AgentResponse::err(
                "503 Service Unavailable",
                "daemon 未连上中心：这些操作要经中心才能让用户看见",
            ));
        }
        if !try_insert_agent_pending(&mut s.agent_pending, request_id.clone(), tx) {
            return Err(AgentResponse::err(
                "429 Too Many Requests",
                "agent 控制请求并发已达上限，请稍后重试",
            ));
        }
    }
    // try_send 而非 send，且必须看返回值：出站队列有界，断连期间会满。阻塞会让 agent 干等到
    // 超时，静默丢弃更糟（同样干等）——满了就立刻说「发不出去」。发送失败要自己摘 pending。
    let envelope = wire::DaemonToServer {
        payload: Some(daemon_to_server::Payload::AgentControlRequest(
            wire::AgentControlRequest {
                request_id: request_id.clone(),
                session_id,
                payload: Some(payload),
            },
        )),
    };
    if to_server_tx.try_send(envelope.encode_to_vec()).is_err() {
        state.lock().unwrap().agent_pending.remove(&request_id);
        return Err(AgentResponse::err(
            "503 Service Unavailable",
            "与中心的出站队列已满或已断开，请重试",
        ));
    }

    let outcome = tokio::time::timeout(SERVER_TIMEOUT, rx).await;
    // 无论成败都摘掉 pending：超时/断连后迟到的回执没有接收方，留着就是泄漏。
    state.lock().unwrap().agent_pending.remove(&request_id);
    match outcome {
        Ok(Ok(result)) => {
            if !result.ok {
                return Err(AgentResponse::err(
                    "400 Bad Request",
                    result.error.unwrap_or_else(|| "中心拒绝了该操作".into()),
                ));
            }
            result
                .payload
                .ok_or_else(|| AgentResponse::err("502 Bad Gateway", "中心回执缺少结果"))
        }
        // 发送端被丢弃 = 连接断开时清了 pending 表
        Ok(Err(_)) => Err(AgentResponse::err(
            "503 Service Unavailable",
            "与中心的连接中断，请重试",
        )),
        Err(_) => Err(AgentResponse::err("504 Gateway Timeout", "中心响应超时")),
    }
}

/// TaskStatus → agent 可读的字符串。未知值按 "unknown" 处理而非 panic。
fn status_name(status: i32) -> &'static str {
    match wire::TaskStatus::try_from(status) {
        Ok(wire::TaskStatus::Idle) => "idle",
        Ok(wire::TaskStatus::Running) => "running",
        Ok(wire::TaskStatus::Exited) => "exited",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_shapes_are_agent_readable() {
        let ok = AgentResponse::ok(serde_json::json!({ "taskId": "t1" }));
        assert_eq!(ok.status, "200 OK");
        let parsed: serde_json::Value = serde_json::from_str(&ok.body).expect("ok 体是 JSON");
        assert_eq!(parsed["ok"], serde_json::json!(true));
        assert_eq!(parsed["taskId"], serde_json::json!("t1"));

        let err = AgentResponse::err("403 Forbidden", "不在 coflux 终端里");
        let parsed: serde_json::Value = serde_json::from_str(&err.body).expect("err 体是 JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(parsed["error"], serde_json::json!("不在 coflux 终端里"));
    }

    #[test]
    fn status_names_cover_task_states() {
        assert_eq!(status_name(wire::TaskStatus::Idle as i32), "idle");
        assert_eq!(status_name(wire::TaskStatus::Running as i32), "running");
        assert_eq!(status_name(wire::TaskStatus::Exited as i32), "exited");
        assert_eq!(status_name(999), "unknown");
    }

    #[test]
    fn request_ids_are_unique() {
        let first = next_request_id();
        let second = next_request_id();
        assert_ne!(first, second);
    }

    #[test]
    fn pending_agent_controls_stop_at_hard_limit() {
        let mut pending = HashMap::new();
        for index in 0..AGENT_PENDING_LIMIT {
            let (tx, _rx) = oneshot::channel();
            assert!(try_insert_agent_pending(
                &mut pending,
                format!("request-{index}"),
                tx
            ));
        }
        let (tx, _rx) = oneshot::channel();
        assert!(!try_insert_agent_pending(
            &mut pending,
            "overflow".into(),
            tx
        ));
        assert_eq!(pending.len(), AGENT_PENDING_LIMIT);
    }
}

/// 中心发起的终端读/写（plan 091，与 AgentControlRequest 方向相反）。两种动作都是无落库副作用的
/// 直发请求：读走「命令日志尾部优先、否则 sessiond 当前快照、都没有则 source=none 交中心退回
/// checkpoint」；写经 [`DeviceRuntime::agent_send_input`] 正门——人类 holder 在场时被拒，错误文案
/// 原样回中心（同 `cofluxd terminal send` 的人类优先纪律）。每条请求必回一条 result。
pub async fn handle_server_request(
    request: wire::ServerAgentRequest,
    state: &Arc<Mutex<WorkerState>>,
    device: &Arc<DeviceRuntime>,
) -> wire::ServerAgentResult {
    let request_id = request.request_id;
    let fail = |error: String| wire::ServerAgentResult {
        request_id: request_id.clone(),
        ok: false,
        error: Some(error),
        payload: None,
    };
    match request.payload {
        Some(server_agent_request::Payload::TerminalRead(read)) => {
            let max_bytes = u64::from(read.max_bytes).clamp(1, MAX_SERVER_READ_BYTES);
            let reply = |data: Vec<u8>, source: &str| wire::ServerAgentResult {
                request_id: request_id.clone(),
                ok: true,
                error: None,
                payload: Some(server_agent_result::Payload::TerminalRead(
                    wire::ServerTerminalReadResult {
                        data,
                        source: source.to_string(),
                    },
                )),
            };
            let log_path = { state.lock().unwrap().agent_logs.get(&read.task_id).cloned() };
            if let Some(text) = log_path
                .as_deref()
                .and_then(|path| ops::read_command_log_tail(path, max_bytes))
            {
                return reply(text.into_bytes(), "log");
            }
            // 没有命令日志（用户手开的终端、或 worker 热升级后表已丢）：会话仍活着就取 sessiond
            // 当前快照。只认中心给的 session 与本地 alive 表一致的情况，不按裸 task 猜。
            let session_alive = !read.session_id.is_empty()
                && state
                    .lock()
                    .unwrap()
                    .alive
                    .get(&read.session_id)
                    .is_some_and(|(task_id, _)| task_id == &read.task_id);
            if !session_alive {
                return reply(Vec::new(), "none");
            }
            match device.read_session_snapshot(&read.session_id).await {
                Ok(mut snapshot) => {
                    let keep = usize::try_from(max_bytes).unwrap_or(usize::MAX);
                    if snapshot.len() > keep {
                        snapshot.drain(..snapshot.len() - keep);
                    }
                    reply(snapshot, "snapshot")
                }
                Err(error) => fail(error),
            }
        }
        Some(server_agent_request::Payload::TerminalInput(input)) => {
            if input.data.is_empty() {
                return fail("输入为空".into());
            }
            if input.data.len() > MAX_SERVER_INPUT_BYTES {
                return fail(format!("单次输入超过 {MAX_SERVER_INPUT_BYTES} 字节上限"));
            }
            match device.agent_send_input(&input.session_id, input.data).await {
                Ok(()) => wire::ServerAgentResult {
                    request_id: request_id.clone(),
                    ok: true,
                    error: None,
                    payload: Some(server_agent_result::Payload::TerminalInput(
                        wire::ServerTerminalInputResult {},
                    )),
                },
                Err(message) => fail(message),
            }
        }
        None => fail("未知的中心请求动作（daemon 不认识该 payload）".into()),
    }
}
