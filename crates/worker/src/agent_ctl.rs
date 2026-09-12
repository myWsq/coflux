//! agent 协同控制端点（plan 074）：跑在 coflux PTY 里的 claude/codex 经
//! `coflux terminal|notify|ports` 把自己的工作外化成用户在 web/手机上**看得见、能接管**的
//! coflux 实体——而不是在自己的 Bash 里后台起一个谁也看不见的进程。
//!
//! **身份不靠凭证靠位置**：调用方把自己的 pid 报上来，worker 反查它落在哪个存活 session 的
//! 进程树内（[`agents::session_of_pid`]）。树外 pid 一律拒——这既是身份也是权限边界：只有
//! coflux 自己起的 PTY 里的进程能进来，本机其它进程（含被网页驱动的本地程序）都进不来，
//! 而且能力天然被钉死在「发起方所属的那个 session」上。agent 侧因此不需要任何凭证。
//!
//! **跟随调用方 cwd（plan 102）**：agent 可以经 `/cd`、EnterWorktree 把活着的会话挪进同设备的
//! 另一个 coflux 工作区。每条请求都带调用方 cwd，[`resolve_scope`] 把它解析成**有效工作区**
//! （[`crate::workspace_match`]），本地动作按它判定归属、经中心的动作把它申报给中心核验。
//! 会话的**归属**工作区仍只来自账本，永远不按 cwd 猜。
//!
//! **跟随进入 worktree（plan 104）**：纯 `cd` 只改**目标**（上一段），显式的 EnterWorktree /
//! ExitWorktree / resume / WorktreeRemove 则真的搬**归属**——[`AgentAction::WorkspaceLocate`]
//! 与 [`AgentAction::WorkspaceForget`] 在本地解析 worktree 身份（见 [`crate::worktree_locate`]）、
//! 交中心核验落库，再按中心的响应更新账本。账本仍然只从中心学，只是多了这一个学的时机。
//!
//! **本地能闭环的不碰中心（plan 094）**：send / run / read / wait / close / notify / progress 全在 daemon
//! 本地完成——归属校验（目标与调用方的有效工作区相同）、命令状态与退出码来自 [`crate::session_ledger`]，
//! 内容来自 sessiond 快照（滚动缓冲 + 当前屏），presence 标注改 observed 后立即上报（断连期间由重连后的
//! 全量补发兜底）。它们不要求 daemon 此刻连着中心。只有 new / list / ports 转成 `AgentControlRequest` 交给
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
use crate::{
    agents, device::DeviceRuntime, observed::ObservedState, workspace_match, worktree_locate,
    WorkerState, WsOut,
};

/// 等中心回执的上限：只防在飞请求永久占住 pending 表，CLI 侧自己的超时更短。
const SERVER_TIMEOUT: Duration = Duration::from_secs(20);
/// notify 留言长度上限（字符）。它只是侧栏 tooltip 里的一句话，不是日志通道。
const MAX_NOTIFY_CHARS: usize = 200;
/// 中心回执关联表只保存正在等待的 agent 控制请求；达到上限立即拒绝，不能让本地 HTTP
/// 并发在 20 秒超时窗口内无界堆积。
const AGENT_PENDING_LIMIT: usize = 128;

/// 单次 ServerTerminalRead 回给中心的字节上限（worker 侧钳制；中心再按行数收窄，与 checkpoint 同级）。
const MAX_SERVER_READ_BYTES: u64 = 256 * 1024;
/// ServerTerminalInput 单次写入字节上限：MCP 一次 send 是一行命令或一小段文本，不是文件通道。
const MAX_SERVER_INPUT_BYTES: usize = 64 * 1024;

/// gateway 解析出的一条 agent 控制请求；`respond` 回填 HTTP 应答。
pub struct AgentRequest {
    pub pid: i32,
    pub ppid: i32,
    /// 调用方申报的当前工作目录（plan 102）：CLI 每条请求都带 `process.cwd()`，daemon 据此
    /// 解析有效工作区。旧 CLI 不带，为空串 = 退回会话的归属工作区（今天的行为）。
    pub cwd: String,
    pub action: AgentAction,
    pub respond: oneshot::Sender<AgentResponse>,
}

pub enum AgentAction {
    /// `terminal new`: the workspace's default login shell on a real tty, alive until `exit`
    /// or `close`. There is only this one kind of terminal; a command to type in after the
    /// prompt is a separate `terminal.run` request.
    TerminalNew {
        title: String,
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
    /// `coflux workspace`（plan 102）：只读地报出调用方 cwd 对应的有效工作区与会话的归属
    /// 工作区，让 agent 一眼看出自己有没有「挪窝」。纯本地。
    WorkspaceCurrent,
    /// `coflux workspace locate <path>`（plan 104）：把本会话终端的**归属**搬到 path 所属的
    /// 工作区（未登记的同仓库 worktree 先登记）。Enter / Exit / SessionStart 共用它。
    WorkspaceLocate { path: String },
    /// `coflux workspace forget <path>`（plan 104）：Claude Code 已清理掉该 worktree，
    /// 其下所有终端搬回项目主工作区、工作区记录消失。
    WorkspaceForget { path: String },
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
                request.cwd,
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
    cwd: String,
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
    // 归属与目标一次算清（plan 102）：归属来自账本，目标看调用方 cwd 落在哪个本地工作区。
    // canonicalize 要走文件系统，故 resolve_scope 内部先取表再放锁，不在锁里做 syscall。
    let scope = resolve_scope(state, &session_id, &cwd);

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
        AgentAction::TerminalNew { title } => {
            // The center records the Task and hands the create to this daemon; the supervisor
            // starts the default login shell in the target workspace (stdin and stdout on a real
            // tty). Nothing is typed here: `terminal.run` does that once the prompt mark arrives.
            let payload = agent_control_request::Payload::TerminalNew(wire::AgentTerminalNew {
                title,
                // Unused wire field (see daemon.proto): always empty.
                shell: String::new(),
            });
            match ask_server(state, to_server_tx, session_id, scope.declared(), payload).await {
                Err(response) => response,
                Ok(agent_control_result::Payload::TerminalNew(result)) => {
                    AgentResponse::ok(
                        serde_json::json!({ "taskId": result.task_id, "sessionId": result.session_id }),
                    )
                }
                Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
            }
        }
        AgentAction::TerminalList => {
            let payload = agent_control_request::Payload::TerminalList(wire::AgentTerminalList {});
            match ask_server(state, to_server_tx, session_id, scope.declared(), payload).await {
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
            // Local-first (plan 094): ownership and status come from the session ledger, the
            // content is the sessiond snapshot of a live session — the rendered scrollback plus
            // the current screen, up to the supervisor's history limit — and empty once the
            // shell has exited. The center is not asked; its checkpoint is a derived cache of
            // this very snapshot. ANSI is returned as is; the CLI strips it.
            let (target_session, record) = match resolve_local_target(state, &scope, &task_id) {
                Ok(found) => found,
                Err(response) => return response,
            };
            let text = if record.phase == SessionPhase::Running {
                device
                    .read_session_snapshot(&target_session)
                    .await
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            AgentResponse::ok(serde_json::json!({
                "ansi": text,
                "capturedAt": epoch_ms(),
                "status": phase_name(&record.phase),
                "exitCode": exit_code_of(&record.phase),
            }))
        }
        AgentAction::TerminalStatus { task_id } => {
            match resolve_local_target(state, &scope, &task_id) {
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
            let (target_session, record) = match resolve_local_target(state, &scope, &task_id) {
                Ok(found) => found,
                Err(response) => return response,
            };
            match record.phase {
                SessionPhase::Exited { .. } => {
                    return AgentResponse::err(
                        "409 Conflict",
                        "终端已退出，不能再输入（要跑新命令用 coflux terminal new）",
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
            // 端口挂在**本会话进程树**上，与调用方 cwd 在哪个工作区无关：不申报目标工作区。
            let payload = agent_control_request::Payload::PortsList(wire::AgentPortsList {});
            match ask_server(state, to_server_tx, session_id, String::new(), payload).await {
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
        AgentAction::WorkspaceCurrent => match scope.require_effective() {
            Err(response) => response,
            Ok(effective) => AgentResponse::ok(serde_json::json!({
                "workspaceId": effective,
                "path": scope.effective_path.clone().unwrap_or_default(),
                "owningWorkspaceId": scope.owning,
                "moved": scope.moved(),
                "cwd": cwd,
            })),
        },
        AgentAction::WorkspaceLocate { path } => {
            locate_workspace(state, to_server_tx, &session_id, &scope, &path).await
        }
        AgentAction::WorkspaceForget { path } => {
            forget_workspace(state, to_server_tx, &session_id, &scope, &path).await
        }
    }
}

/// 把本会话终端的归属定位到 `path` 所属的工作区（plan 104）。
///
/// 身份解析全在本地（只有 daemon 手里有 git 和真实路径），落库全在中心（归属的唯一真相）。
/// 「不适用」的三种情形（目录工作区起步、目标非 git、跨仓库）在本地就止步，一条消息都不发。
async fn locate_workspace(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &mpsc::Sender<WsOut>,
    session_id: &str,
    scope: &WorkspaceScope,
    path: &str,
) -> AgentResponse {
    if path.trim().is_empty() {
        return AgentResponse::err("400 Bad Request", "workspace locate 缺 path");
    }
    let owning = match scope.require_owning() {
        Ok(owning) => owning.to_string(),
        Err(response) => return response,
    };
    // 表克隆一份再放锁：下面要 canonicalize 并起 git 子进程，不能在 WorkerState 的锁里做。
    let workspaces = { state.lock().unwrap().workspaces.clone() };
    let Some((owning_path, _)) = workspaces.get(&owning).cloned() else {
        return AgentResponse::err(
            "409 Conflict",
            "本终端的归属工作区还没同步到 daemon，稍后重试",
        );
    };
    let owning_facts = crate::git::repo_facts(&owning_path).await;
    let target_facts = crate::git::repo_facts(path).await;
    let (workspace_id, root, branch) =
        match worktree_locate::decide(&workspaces, owning_facts.as_ref(), target_facts.as_ref()) {
            worktree_locate::Locate::Existing {
                workspace_id,
                root,
                branch,
            } => (workspace_id, root, branch),
            worktree_locate::Locate::Register { root, branch } => (String::new(), root, branch),
            worktree_locate::Locate::NotApplicable(reason) => {
                return AgentResponse::err("409 Conflict", reason)
            }
        };
    let payload =
        agent_control_request::Payload::WorkspaceLocate(wire::AgentWorkspaceLocate {
            path: root,
            branch,
            workspace_id,
            // 走到这里 decide 已核验过同仓库；跨仓库/非 git 在上面就返回了
            same_repo: true,
        });
    // 申报的**目标**留空：这条消息改的是归属，不是本次请求打到哪个工作区（plan 102 的字段）。
    match ask_server(state, to_server_tx, session_id.to_string(), String::new(), payload).await {
        Err(response) => response,
        Ok(agent_control_result::Payload::WorkspaceLocate(result)) => {
            // 账本只从中心的响应学（plan 094/103）：跟上之后 102 的 resolve_scope 才会得出
            // 有效 == 归属，挪窝块自然归于沉默。
            state
                .lock()
                .unwrap()
                .ledger
                .move_workspace(session_id, &result.workspace_id);
            AgentResponse::ok(serde_json::json!({
                "workspaceId": result.workspace_id,
                "path": result.path,
                "branch": result.branch,
                "created": result.created,
                "moved": result.moved,
            }))
        }
        Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
    }
}

/// Claude Code 清理掉了 `path` 这个 worktree（plan 104）：中心把该工作区下所有终端搬回项目
/// 主工作区并删掉记录。daemon 绝不在这条路径上执行 `git worktree remove`——目录已经没了。
async fn forget_workspace(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &mpsc::Sender<WsOut>,
    session_id: &str,
    scope: &WorkspaceScope,
    path: &str,
) -> AgentResponse {
    if path.trim().is_empty() {
        return AgentResponse::err("400 Bad Request", "workspace forget 缺 path");
    }
    if let Err(response) = scope.require_owning() {
        return response;
    }
    let workspaces = { state.lock().unwrap().workspaces.clone() };
    let workspace_id = worktree_locate::workspace_at_root(&workspaces, path).unwrap_or_default();
    if workspace_id.is_empty() {
        // 从来没登记过（Claude 建了又删、coflux 一直不知道它）：本来就没有记录要删。
        return AgentResponse::err("404 Not Found", "该 worktree 不是 coflux 登记过的工作区");
    }
    let payload = agent_control_request::Payload::WorkspaceForget(wire::AgentWorkspaceForget {
        path: worktree_locate::normalize_display(path),
        workspace_id,
    });
    match ask_server(state, to_server_tx, session_id.to_string(), String::new(), payload).await {
        Err(response) => response,
        Ok(agent_control_result::Payload::WorkspaceForget(result)) => {
            // 搬回主工作区的不只发起方这一个会话：该工作区下的每个终端都跟着回去了。
            state
                .lock()
                .unwrap()
                .ledger
                .move_all_workspaces(&result.workspace_id, &result.fallback_workspace_id);
            AgentResponse::ok(serde_json::json!({
                "workspaceId": result.workspace_id,
                "fallbackWorkspaceId": result.fallback_workspace_id,
                "movedTerminals": result.moved_terminals,
                "removed": result.removed,
            }))
        }
        Ok(_) => AgentResponse::err("502 Bad Gateway", "中心回执类型不匹配"),
    }
}

/// 调用方这一次请求的工作区坐标（plan 102）。
struct WorkspaceScope {
    /// **归属工作区**：本会话是在哪个工作区开的（agent 侧的 `COFLUX_WORKSPACE_ID`）。只认中心随
    /// SessionCreate 下发的 id，空串 = 未知。
    owning: String,
    /// **有效工作区**：调用方 cwd 命中的工作区；cwd 不在任何已知工作区内就是归属工作区本身。
    /// 归属未知时同样为空——cwd 只能把目标**改向**一个已知归属，绝不**补上**缺失的归属。
    effective: String,
    /// 有效工作区在本机的路径（工作区表里的登记值）；表里查不到则 None。
    effective_path: Option<String>,
}

impl WorkspaceScope {
    /// 挪窝了：agent 经 `/cd`/EnterWorktree 把会话挪进了同设备的另一个工作区。
    fn moved(&self) -> bool {
        !self.effective.is_empty() && self.effective != self.owning
    }

    /// 经中心的动作要申报的目标工作区：只在挪窝时申报。没挪窝就留空——空 = 中心用发起 task 的
    /// 工作区，与旧 worker 的请求逐字节等价，常态一点没变。
    fn declared(&self) -> String {
        if self.moved() {
            self.effective.clone()
        } else {
            String::new()
        }
    }

    /// 本地命令要用的有效工作区；归属未知时给出与 plan 094 同样的可读拒绝。
    fn require_effective(&self) -> Result<&str, AgentResponse> {
        if self.effective.is_empty() {
            return Err(AgentResponse::err(
                "409 Conflict",
                "本终端早于 daemon 升级，缺少工作区归属：重开终端后再用本地命令",
            ));
        }
        Ok(&self.effective)
    }

    /// 改归属的动作（plan 104）要的是**归属**本身：没有归属就没有可搬的东西，也绝不按 cwd 补。
    fn require_owning(&self) -> Result<&str, AgentResponse> {
        if self.owning.is_empty() {
            return Err(AgentResponse::err(
                "409 Conflict",
                "本终端早于 daemon 升级，缺少工作区归属：重开终端后 coflux 才能跟随 worktree",
            ));
        }
        Ok(&self.owning)
    }
}

/// 归属只查账本，目标看 cwd（plan 102）。
fn resolve_scope(
    state: &Arc<Mutex<WorkerState>>,
    caller_session: &str,
    cwd: &str,
) -> WorkspaceScope {
    let (owning, workspaces) = {
        let s = state.lock().unwrap();
        let owning = s
            .ledger
            .session(caller_session)
            .map(|record| record.workspace_id.clone())
            .unwrap_or_default();
        // 表克隆一份再放锁：下面的最长前缀匹配要 canonicalize，不能在 WorkerState 的锁里做 syscall。
        (owning, s.workspaces.clone())
    };
    if owning.is_empty() {
        return WorkspaceScope {
            owning,
            effective: String::new(),
            effective_path: None,
        };
    }
    let effective =
        workspace_match::workspace_for_cwd(&workspaces, cwd).unwrap_or_else(|| owning.clone());
    let effective_path = workspaces.get(&effective).map(|(path, _)| path.clone());
    WorkspaceScope {
        owning,
        effective,
        effective_path,
    }
}

/// 本地命令的目标解析（plan 094 + 102）：调用方与目标都必须有已知归属，且目标的归属等于调用方的
/// **有效工作区**（cwd 落在哪个工作区，就对哪个工作区的终端说话）。归属永远不猜——早于 daemon
/// 升级的会话归属未知，一律可读拒绝；能按申报的 cwd 改向的只是**目标**。
/// 「不在本工作区」与「不存在」同一句错误——不向别的工作区泄漏存在性。
fn resolve_local_target(
    state: &Arc<Mutex<WorkerState>>,
    scope: &WorkspaceScope,
    task_id: &str,
) -> Result<(String, SessionRecord), AgentResponse> {
    let effective = scope.require_effective()?;
    let s = state.lock().unwrap();
    let not_found = || {
        AgentResponse::err(
            "404 Not Found",
            "终端不在本工作区或不存在（用 coflux terminal list 查）",
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
    if target.workspace_id != effective {
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
///
/// `workspace_id` 是**申报**的目标工作区（plan 102）：只有 agent 挪进同设备另一个工作区时才非空，
/// 中心核验同账号同设备后以它为目标；空 = 中心用发起 task 的工作区（旧 worker 恒空）。
async fn ask_server(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &mpsc::Sender<WsOut>,
    session_id: String,
    workspace_id: String,
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
                workspace_id,
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

    fn scope(owning: &str, effective: &str) -> WorkspaceScope {
        WorkspaceScope {
            owning: owning.into(),
            effective: effective.into(),
            effective_path: Some("/x/repo".into()),
        }
    }

    #[test]
    fn target_workspace_is_declared_only_after_moving() {
        // 没挪窝：字段留空，请求与旧 worker 逐字节等价（中心用发起 task 的工作区）
        assert_eq!(scope("ws-a", "ws-a").declared(), "");
        assert!(!scope("ws-a", "ws-a").moved());
        // 挪进了同设备的另一个工作区：申报它，交中心核验
        assert_eq!(scope("ws-a", "ws-b").declared(), "ws-b");
        assert!(scope("ws-a", "ws-b").moved());
    }

    #[test]
    fn missing_ownership_is_refused_readably_and_never_guessed_from_cwd() {
        let unknown = WorkspaceScope {
            owning: String::new(),
            effective: String::new(),
            effective_path: None,
        };
        assert_eq!(unknown.declared(), "", "归属未知时绝不申报目标");
        let refused = unknown.require_effective().expect_err("必须拒绝");
        assert_eq!(refused.status, "409 Conflict");
        assert!(refused.body.contains("早于 daemon 升级"), "{}", refused.body);
        // AgentResponse 没有 Debug，用 .ok() 取值而不是 unwrap
        assert_eq!(scope("ws-a", "ws-b").require_effective().ok(), Some("ws-b"));
    }

    #[test]
    fn following_a_worktree_needs_ownership_not_the_cwd_target() {
        // 改归属的动作要的是归属本身：cwd 挪到哪都不影响「谁在搬」
        assert_eq!(scope("ws-a", "ws-b").require_owning().ok(), Some("ws-a"));
        let unknown = WorkspaceScope {
            owning: String::new(),
            effective: String::new(),
            effective_path: None,
        };
        let refused = unknown.require_owning().expect_err("必须拒绝");
        assert_eq!(refused.status, "409 Conflict");
        assert!(refused.body.contains("跟随 worktree"), "{}", refused.body);
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

/// Center-initiated terminal reads and writes (plan 091, the opposite direction of
/// AgentControlRequest). Both are direct requests without durable side effects: a read answers
/// with the sessiond snapshot of a live session (otherwise `source=none`, and the center falls
/// back to its checkpoint); a write goes through the [`DeviceRuntime::agent_send_input`] front
/// door — refused while a human holder is present, the message forwarded verbatim (the same
/// humans-first rule as `coflux terminal send`). Every request gets exactly one result.
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
            // A live session answers with the sessiond snapshot (scrollback + screen); only the
            // session the center names is trusted, and only while the local alive table agrees.
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
        Some(server_agent_request::Payload::TerminalRun(_))
        | Some(server_agent_request::Payload::TerminalWait(_)) => {
            fail("terminal run/wait are wired in the do-script milestone".into())
        }
        None => fail("未知的中心请求动作（daemon 不认识该 payload）".into()),
    }
}
