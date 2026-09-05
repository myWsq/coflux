//! 中心发起的终端读/写/标注（plan 091 + plan 093）：`ServerAgentRequest` 的 daemon 侧处理器。
//!
//! plan 074/088 曾在这里放过 loopback `/agent` 端点的业务（`cofluxd terminal|notify|progress|ports`，
//! 按调用方 pid 反查进程树认身份、再把动作转成 AgentControlRequest 交中心）。plan 093 把 agent
//! 能力面收成中心 MCP 单轨后整条拆除：agent 只经中心 MCP tools 触达 daemon，账号归属校验与能力
//! 门禁都在中心做，这里只剩「中心问、daemon 答」的四个动作：
//! - terminal_read：命令日志尾部优先、否则 sessiond 当前快照、都没有则 source=none 交中心退回 checkpoint；
//! - terminal_input：经 [`DeviceRuntime::agent_send_input`] 正门写 PTY，人类 holder 在场时被拒；
//! - terminal_notify / terminal_progress：给该会话的 agent presence 打标注。语义与 074 时代的
//!   `cofluxd notify/progress` 逐字相同（见 [`crate::observed`] 的三个 apply 函数与清空规则），
//!   **且该会话进程树里现场探测得到 agent 才接受**——presence 报表只给扫到 claude/codex 的会话
//!   建条目，其余会话的标注在下一轮扫描就被 `merge_annotations` 剪掉，静默接受等于静默丢。
//!
//! 每条请求必回一条 result；错误文案原样回中心，由 MCP tool 转给 agent。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use coflux_protocol::wire::{self, server_agent_request, server_agent_result};
use tokio::sync::mpsc;

use crate::{agents, device::DeviceRuntime, observed::ObservedState, ops, WorkerState, WsOut};

/// notify/progress 留言长度上限（字符）。它只是侧栏 tooltip 里的一句话，不是日志通道。
/// 中心入口已按同一上限拒绝（超限即拒，不静默截断），这里是 daemon 侧兜底钳制。
pub(crate) const MAX_NOTIFY_CHARS: usize = 200;
/// agent_logs 表的条目上限。超出即整表清空——丢失只意味着 read 退回 sessiond 快照/中心
/// checkpoint，没有正确性后果，所以不值得为它做 LRU。
/// ponytail: 粗暴清表，真出现「一个工作区几百个终端」的用法再换 LRU。
const MAX_TRACKED_LOGS: usize = 256;
/// 单次 ServerTerminalRead 回给中心的字节上限（worker 侧钳制；中心再按行数收窄，与 checkpoint 同级）。
/// 命令日志汇的单段容量（[`crate::log_sink::SEGMENT_BYTES`]）不得小于它，否则读窗永远填不满。
const MAX_SERVER_READ_BYTES: u64 = 256 * 1024;
/// ServerTerminalInput 单次写入字节上限：MCP 一次 send 是一行命令或一小段文本，不是文件通道。
const MAX_SERVER_INPUT_BYTES: usize = 64 * 1024;

const _: () = assert!(crate::log_sink::SEGMENT_BYTES >= MAX_SERVER_READ_BYTES);

pub(crate) fn remember_log(state: &Arc<Mutex<WorkerState>>, task_id: String, log_path: String) {
    let mut s = state.lock().unwrap();
    if s.agent_logs.len() >= MAX_TRACKED_LOGS {
        s.agent_logs.clear();
    }
    s.agent_logs.insert(task_id, log_path);
}

/// 两种 presence 标注；对应 [`ObservedState::apply_notify`] / [`ObservedState::apply_progress`]。
#[derive(Clone, Copy)]
enum Annotation {
    /// 叫人：state 转 question 并携带留言，下一个 hook 事件即清空
    Notify,
    /// 播报：覆盖式单字段，不改 state，跨 hook 事件存活
    Progress,
}

/// 中心发起的终端读/写/标注：每条请求必回一条 result。读走「命令日志尾部优先、否则 sessiond 当前
/// 快照、都没有则 source=none」；写经 [`DeviceRuntime::agent_send_input`] 正门——人类 holder 在场时
/// 被拒，错误文案原样回中心；标注经 [`annotate_presence`] 的 presence 门后立即触发一次 presence 上报。
pub(crate) async fn handle_server_request(
    request: wire::ServerAgentRequest,
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    device: &Arc<DeviceRuntime>,
    to_server_tx: &mpsc::Sender<WsOut>,
) -> wire::ServerAgentResult {
    let request_id = request.request_id;
    let fail = |error: String| wire::ServerAgentResult {
        request_id: request_id.clone(),
        ok: false,
        error: Some(error),
        payload: None,
    };
    let succeed = |payload: server_agent_result::Payload| wire::ServerAgentResult {
        request_id: request_id.clone(),
        ok: true,
        error: None,
        payload: Some(payload),
    };
    match request.payload {
        Some(server_agent_request::Payload::TerminalRead(read)) => {
            let max_bytes = u64::from(read.max_bytes).clamp(1, MAX_SERVER_READ_BYTES);
            let reply = |data: Vec<u8>, source: &str| {
                succeed(server_agent_result::Payload::TerminalRead(
                    wire::ServerTerminalReadResult {
                        data,
                        source: source.to_string(),
                    },
                ))
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
                Ok(()) => succeed(server_agent_result::Payload::TerminalInput(
                    wire::ServerTerminalInputResult {},
                )),
                Err(message) => fail(message),
            }
        }
        Some(server_agent_request::Payload::TerminalNotify(notify)) => {
            match annotate_presence(
                state,
                observed,
                to_server_tx,
                &notify.task_id,
                &notify.session_id,
                &notify.message,
                Annotation::Notify,
            )
            .await
            {
                Ok(()) => succeed(server_agent_result::Payload::TerminalNotify(
                    wire::ServerTerminalNotifyResult {},
                )),
                Err(message) => fail(message),
            }
        }
        Some(server_agent_request::Payload::TerminalProgress(progress)) => {
            match annotate_presence(
                state,
                observed,
                to_server_tx,
                &progress.task_id,
                &progress.session_id,
                &progress.message,
                Annotation::Progress,
            )
            .await
            {
                Ok(()) => succeed(server_agent_result::Payload::TerminalProgress(
                    wire::ServerTerminalProgressResult {},
                )),
                Err(message) => fail(message),
            }
        }
        None => fail("未知的中心请求动作（daemon 不认识该 payload）".into()),
    }
}

/// 留言规范化：去首尾空白、按字符钳到上限；空留言返回 None。
fn clamp_message(raw: &str) -> Option<String> {
    let message: String = raw.trim().chars().take(MAX_NOTIFY_CHARS).collect();
    (!message.is_empty()).then_some(message)
}

/// presence 门 + 标注 + 立即上报（与 074 时代 CLI 路径的处理点相同）。
///
/// 门有两道：① 中心给的 session 必须在本地 alive 表里且属于同一 task（不按裸 task 猜）；
/// ② **现场探测**该会话进程树，必须扫到 claude/codex——用的是与周期扫描完全相同的
/// [`agents::detect_session_agents`]，所以「这次接受、下一轮被剪掉」不可能发生（除非 agent 恰好
/// 在两次扫描之间退出，那时留言随 presence 一起消失本就是既定语义）。不用「最近一次已提交的
/// 报表」：agent 刚起 2 秒内的调用会被误拒。
async fn annotate_presence(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &mpsc::Sender<WsOut>,
    task_id: &str,
    session_id: &str,
    raw_message: &str,
    kind: Annotation,
) -> Result<(), String> {
    let Some(message) = clamp_message(raw_message) else {
        return Err("留言不能为空".into());
    };
    if session_id.is_empty() {
        return Err("终端还没有会话，无法标注".into());
    }
    let root_pid = state
        .lock()
        .unwrap()
        .alive
        .get(session_id)
        .filter(|(task, _)| task == task_id)
        .map(|(_, pid)| *pid);
    let Some(root_pid) = root_pid else {
        return Err("该终端的会话不在本设备的存活会话里（可能刚退出或正在对账），稍后重试".into());
    };
    let probe: HashMap<String, (String, i32)> =
        HashMap::from([(session_id.to_string(), (task_id.to_string(), root_pid))]);
    let present = tokio::task::spawn_blocking(move || !agents::detect_session_agents(&probe).is_empty())
        .await
        .unwrap_or(false);
    if !present {
        return Err(
            "该终端里没有检测到正在运行的 agent（claude/codex）：留言与进度只能标在有 agent presence 的终端上，先确认 terminalId 是不是你自己的 $COFLUX_TASK_ID"
                .into(),
        );
    }
    match kind {
        Annotation::Notify => observed.apply_notify(session_id.to_string(), message),
        Annotation::Progress => observed.apply_progress(session_id.to_string(), message),
    }
    crate::report_agents_if_changed(state, observed, to_server_tx).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_is_trimmed_clamped_and_never_empty() {
        assert_eq!(clamp_message("  需要你定  ").as_deref(), Some("需要你定"));
        assert_eq!(clamp_message("   "), None);
        assert_eq!(clamp_message(""), None);
        let long: String = "字".repeat(MAX_NOTIFY_CHARS + 50);
        let clamped = clamp_message(&long).expect("非空");
        assert_eq!(clamped.chars().count(), MAX_NOTIFY_CHARS, "按字符而非字节钳制");
    }
}
