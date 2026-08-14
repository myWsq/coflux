//! agent 协同控制端点（plan 074）：跑在 coflux PTY 里的 claude/codex 经
//! `cofluxd terminal|notify|ports` 把自己的工作外化成用户在 web/手机上**看得见、能接管**的
//! coflux 实体——而不是在自己的 Bash 里后台起一个谁也看不见的进程。
//!
//! **身份不靠凭证靠位置**：调用方把自己的 pid 报上来，worker 反查它落在哪个存活 session 的
//! 进程树内（[`agents::session_of_pid`]）。树外 pid 一律拒——这既是身份也是权限边界：只有
//! coflux 自己起的 PTY 里的进程能进来，本机其它进程（含被网页驱动的本地程序）都进不来，
//! 而且能力天然被钉死在「发起方所属的那个 session」上。agent 侧因此不需要任何凭证。
//!
//! **notify 在本地闭环**（改 presence 状态后立即上报）；其余动作转成 `AgentControlRequest`
//! 交给中心，由 server 反查 session→task→workspace 完成归属校验后执行。中心离线时它们必然
//! 失败——明确报错比默默降级好，因为「让用户看得见」正是这些动作的全部意义。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::wire::{self, agent_control_request, agent_control_result, daemon_to_server};
use tokio::sync::{mpsc, oneshot};

use crate::{agents, ops, send_d2s, WorkerState, WsOut};

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

fn remember_log(state: &Arc<Mutex<WorkerState>>, task_id: String, log_path: String) {
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
    TerminalNew { title: String, command: String },
    TerminalList,
    TerminalRead { task_id: String },
    Notify { message: String },
    Ports,
}

pub struct AgentResponse {
    /// HTTP status line，如 "200 OK"
    pub status: &'static str,
    /// JSON 响应体
    pub body: String,
}

impl AgentResponse {
    fn ok(payload: serde_json::Value) -> Self {
        let mut object = serde_json::Map::new();
        object.insert("ok".into(), serde_json::Value::Bool(true));
        if let serde_json::Value::Object(fields) = payload {
            object.extend(fields);
        }
        Self { status: "200 OK", body: serde_json::Value::Object(object).to_string() }
    }

    fn err(status: &'static str, message: impl AsRef<str>) -> Self {
        let body = serde_json::json!({ "ok": false, "error": message.as_ref() });
        Self { status, body: body.to_string() }
    }
}

/// request_id 的进程内序号；与 pid 一起构成本 daemon 内唯一的关联键（server 只用它做响应
/// 关联，不承担幂等——见 daemon.proto 里 AgentControlRequest 的契约注释）。
static NEXT_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_request_id() -> String {
    format!("agent-{}-{}", std::process::id(), NEXT_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 消费循环：每条请求先过 pid 身份门，再按动作分派。
pub async fn consume_agent_requests(mut rx: mpsc::Receiver<AgentRequest>, state: Arc<Mutex<WorkerState>>, to_server_tx: mpsc::Sender<WsOut>) {
    while let Some(request) = rx.recv().await {
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        // 每条请求独立任务：terminal.* 要等中心回执（最长 SERVER_TIMEOUT），不能阻塞后续请求。
        tokio::spawn(async move {
            let response = handle(&state, &to_server_tx, request.pid, request.ppid, request.action).await;
            let _ = request.respond.send(response);
        });
    }
}

async fn handle(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &mpsc::Sender<WsOut>,
    pid: i32,
    ppid: i32,
    action: AgentAction,
) -> AgentResponse {
    let alive = { state.lock().unwrap().alive.clone() };
    let session_id = tokio::task::spawn_blocking(move || agents::session_of_pid(&alive, pid, ppid)).await.ok().flatten();
    let Some(session_id) = session_id else {
        return AgentResponse::err("403 Forbidden", "不在 coflux 终端里：本命令只能由 coflux 会话内的进程调用");
    };

    match action {
        AgentAction::Notify { message } => {
            let message: String = message.chars().take(MAX_NOTIFY_CHARS).collect();
            {
                let mut s = state.lock().unwrap();
                s.hook_states.insert(session_id.clone(), "question");
                s.hook_messages.insert(session_id, message);
            }
            crate::report_agents_if_changed(state, to_server_tx).await;
            AgentResponse::ok(serde_json::json!({}))
        }
        AgentAction::TerminalNew { title, command } => {
            let (shell, log_path) = match ops::write_command_script(&command) {
                Ok(paths) => paths,
                Err(error) => return AgentResponse::err("500 Internal Server Error", format!("写命令脚本失败：{error}")),
            };
            let payload = agent_control_request::Payload::TerminalNew(wire::AgentTerminalNew { title, shell });
            match ask_server(state, to_server_tx, session_id, payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::TerminalNew(result)) => {
                    remember_log(state, result.task_id.clone(), log_path);
                    AgentResponse::ok(serde_json::json!({ "taskId": result.task_id, "sessionId": result.session_id }))
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
            // 先问中心：它做归属校验（该 task 必须与发起方同工作区）并给出 status/exit_code。
            // 内容的**首选**数据源是本地命令日志：中心 checkpoint 是 2 秒周期的派生缓存，
            // 秒级命令的输出根本进不去，而日志是全量而非一屏。非 agent 自建的终端（用户
            // 手开的）没有日志，此时退回 checkpoint。
            let local_log = { state.lock().unwrap().agent_logs.get(&task_id).cloned() };
            let payload = agent_control_request::Payload::TerminalRead(wire::AgentTerminalRead { task_id });
            match ask_server(state, to_server_tx, session_id, payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::TerminalRead(result)) => {
                    let from_log = local_log.as_deref().and_then(|path| ops::read_command_log_tail(path, MAX_LOG_TAIL_BYTES));
                    // ANSI 原样带回，去转义在 CLI 侧做（snapshot 同时是 checkpoint 的数据来源，
                    // 不为 agent 可读性改它的语义）。
                    let text = from_log.unwrap_or_else(|| String::from_utf8_lossy(&result.ansi_snapshot).into_owned());
                    AgentResponse::ok(serde_json::json!({
                        "ansi": text,
                        "capturedAt": result.captured_at,
                        "status": status_name(result.status),
                        "exitCode": result.exit_code,
                    }))
                }
                Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
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
            return Err(AgentResponse::err("503 Service Unavailable", "daemon 未连上中心：这些操作要经中心才能让用户看见"));
        }
        s.agent_pending.insert(request_id.clone(), tx);
    }
    send_d2s(
        to_server_tx,
        daemon_to_server::Payload::AgentControlRequest(wire::AgentControlRequest {
            request_id: request_id.clone(),
            session_id,
            payload: Some(payload),
        }),
    )
    .await;

    let outcome = tokio::time::timeout(SERVER_TIMEOUT, rx).await;
    // 无论成败都摘掉 pending：超时/断连后迟到的回执没有接收方，留着就是泄漏。
    state.lock().unwrap().agent_pending.remove(&request_id);
    match outcome {
        Ok(Ok(result)) => {
            if !result.ok {
                return Err(AgentResponse::err("400 Bad Request", result.error.unwrap_or_else(|| "中心拒绝了该操作".into())));
            }
            result.payload.ok_or_else(|| AgentResponse::err("502 Bad Gateway", "中心回执缺少结果"))
        }
        // 发送端被丢弃 = 连接断开时清了 pending 表
        Ok(Err(_)) => Err(AgentResponse::err("503 Service Unavailable", "与中心的连接中断，请重试")),
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
}
