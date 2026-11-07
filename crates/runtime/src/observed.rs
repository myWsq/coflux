//! daemon 派生观测状态：会话端口、agent presence，以及 presence 上的本地 annotation。
//!
//! 本模块不拥有 session catalog：`alive` 的权威仍是 supervisor/sessiond，调用方只把
//! `WorkerState` 中的瞬时快照传进来。这里仅负责阻塞扫描、全量快照去重和重连时的强制补发
//! 基准；同样不感知认证、WebSocket 生命周期或出站队列。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use coflux_protocol::wire;
use tokio::sync::Mutex as AsyncMutex;

use crate::sessiond::{BlockedKind, ProgramState, ProgramStatus};
use crate::{agents, ports};

pub(crate) type SessionProcesses = HashMap<String, (String, i32)>;

/// Task id per alive session: the part of the alive snapshot the presence merge needs.
type AliveTasks = HashMap<String, String>;

/// Longest agent name a program may report about itself, in bytes.
const MAX_PROGRAM_APP_BYTES: usize = 32;

/// Agent name for a reporting program that gave none and was not recognised by process.
const UNNAMED_PROGRAM_AGENT: &str = "agent";

#[derive(Default)]
struct ObservedInner {
    last_reported_ports: Vec<wire::SessionPorts>,
    last_reported_agents: Vec<wire::SessionAgentRef>,
    ports_delivery_dirty: bool,
    agents_delivery_dirty: bool,
    hook_progress: HashMap<String, String>,
    /// The agent's own session id per coflux session (plan 20260919). It lives like
    /// `hook_progress`: it identifies the session, so it must survive every turn-state change
    /// and only disappear when the presence entry itself does.
    hook_agent_sessions: HashMap<String, String>,
    /// The root OSC 7501 record per session, as sessiond pushed it: the only source of an
    /// entry's state and message, and the preferred source of its agent name.
    program_status: HashMap<String, ProgramStatus>,
}

/// 一份待发送观测值，同时持有对应类型的 scan lane。调用方必须在 enqueue 完成并按结果
/// 标记 delivery 后再 drop；这样同类 scan→enqueue 是一个全序，旧快照不能晚于新快照入队。
pub(crate) struct ObservedReport<'a, T> {
    value: T,
    inner: &'a Mutex<ObservedInner>,
    kind: ObservedKind,
    acknowledged: bool,
    _lane: tokio::sync::MutexGuard<'a, ()>,
}

impl<T> ObservedReport<'_, T> {
    pub(crate) fn value(&self) -> &T {
        &self.value
    }

    /// 只有 payload 已成功进入出站队列才确认；发送失败或 future 被取消时由 Drop 自动
    /// 标记 delivery dirty，下一轮相同快照仍会补发。
    pub(crate) fn acknowledge(mut self) {
        self.acknowledged = true;
    }
}

impl<T> Drop for ObservedReport<'_, T> {
    fn drop(&mut self) {
        if self.acknowledged {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        match self.kind {
            ObservedKind::Ports => inner.ports_delivery_dirty = true,
            ObservedKind::Agents => inner.agents_delivery_dirty = true,
        }
    }
}

#[derive(Clone, Copy)]
enum ObservedKind {
    Ports,
    Agents,
}

/// 两类扫描各自串行，避免周期扫描、hook 即时刷新和重连 force 的旧结果倒序覆盖；
/// ports 与 agents 互不阻塞。lane 从截取 alive 快照前一直持有到调用方完成 enqueue。
pub(crate) struct ObservedState {
    inner: Mutex<ObservedInner>,
    ports_scan_lane: AsyncMutex<()>,
    agents_scan_lane: AsyncMutex<()>,
}

impl Default for ObservedState {
    fn default() -> Self {
        Self::new()
    }
}

impl ObservedState {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(ObservedInner::default()),
            ports_scan_lane: AsyncMutex::new(()),
            agents_scan_lane: AsyncMutex::new(()),
        }
    }

    /// Record the agent's own session id (sent by its hooks). Independent of turn state, which
    /// comes from OSC 7501.
    pub(crate) fn apply_agent_session_id(&self, session_id: String, agent_session_id: String) {
        self.inner
            .lock()
            .unwrap()
            .hook_agent_sessions
            .insert(session_id, agent_session_id);
    }

    /// Record (or, with `None`, forget) a session's root OSC 7501 record.
    pub(crate) fn apply_program_status(&self, session_id: String, status: Option<ProgramStatus>) {
        let mut inner = self.inner.lock().unwrap();
        match status {
            Some(status) => {
                inner.program_status.insert(session_id, status);
            }
            None => {
                inner.program_status.remove(&session_id);
            }
        }
    }

    /// progress 是独立信道：不改变 state/message，只保留最新一条。
    pub(crate) fn apply_progress(&self, session_id: String, message: String) {
        self.inner
            .lock()
            .unwrap()
            .hook_progress
            .insert(session_id, message);
    }

    pub(crate) async fn ports_if_changed<S>(
        &self,
        snapshot: S,
    ) -> Option<ObservedReport<'_, wire::PortsUpdate>>
    where
        S: FnOnce() -> SessionProcesses + Send,
    {
        self.scan_ports_with(snapshot, false, scan_ports).await
    }

    /// 扫描成功就始终返回全量（包括空集），并刷新后续变化比较的基准。
    pub(crate) async fn force_ports<S>(
        &self,
        snapshot: S,
    ) -> Option<ObservedReport<'_, wire::PortsUpdate>>
    where
        S: FnOnce() -> SessionProcesses + Send,
    {
        self.scan_ports_with(snapshot, true, scan_ports).await
    }

    pub(crate) async fn agents_if_changed<S>(
        &self,
        snapshot: S,
    ) -> Option<ObservedReport<'_, wire::SessionAgents>>
    where
        S: FnOnce() -> SessionProcesses + Send,
    {
        self.scan_agents_with(snapshot, false, agents::detect_session_agents)
            .await
    }

    /// 扫描成功就始终返回全量（包括空集），并刷新后续变化比较的基准。
    pub(crate) async fn force_agents<S>(
        &self,
        snapshot: S,
    ) -> Option<ObservedReport<'_, wire::SessionAgents>>
    where
        S: FnOnce() -> SessionProcesses + Send,
    {
        self.scan_agents_with(snapshot, true, agents::detect_session_agents)
            .await
    }

    async fn scan_ports_with<S, F>(
        &self,
        snapshot: S,
        force: bool,
        scan: F,
    ) -> Option<ObservedReport<'_, wire::PortsUpdate>>
    where
        S: FnOnce() -> SessionProcesses + Send,
        F: FnOnce(&SessionProcesses) -> Vec<wire::SessionPorts> + Send + 'static,
    {
        let lane = self.ports_scan_lane.lock().await;
        let alive = snapshot();
        let sessions = tokio::task::spawn_blocking(move || scan(&alive))
            .await
            .ok()?;
        let value = self.commit_ports(sessions, force)?;
        Some(ObservedReport {
            value,
            inner: &self.inner,
            kind: ObservedKind::Ports,
            acknowledged: false,
            _lane: lane,
        })
    }

    async fn scan_agents_with<S, F>(
        &self,
        snapshot: S,
        force: bool,
        scan: F,
    ) -> Option<ObservedReport<'_, wire::SessionAgents>>
    where
        S: FnOnce() -> SessionProcesses + Send,
        F: FnOnce(&SessionProcesses) -> Vec<wire::SessionAgentRef> + Send + 'static,
    {
        let lane = self.agents_scan_lane.lock().await;
        let alive = snapshot();
        let tasks: AliveTasks = alive
            .iter()
            .map(|(session_id, (task_id, _pid))| (session_id.clone(), task_id.clone()))
            .collect();
        let sessions = tokio::task::spawn_blocking(move || scan(&alive))
            .await
            .ok()?;
        let value = self.commit_agents_alive(sessions, &tasks, force)?;
        Some(ObservedReport {
            value,
            inner: &self.inner,
            kind: ObservedKind::Agents,
            acknowledged: false,
            _lane: lane,
        })
    }

    fn commit_ports(
        &self,
        sessions: Vec<wire::SessionPorts>,
        force: bool,
    ) -> Option<wire::PortsUpdate> {
        let mut inner = self.inner.lock().unwrap();
        if !force && !inner.ports_delivery_dirty && inner.last_reported_ports == sessions {
            return None;
        }
        inner.last_reported_ports = sessions.clone();
        inner.ports_delivery_dirty = false;
        Some(wire::PortsUpdate { sessions })
    }

    /// Test shorthand: every scanned session is alive, and nothing else is.
    #[cfg(test)]
    fn commit_agents(
        &self,
        sessions: Vec<wire::SessionAgentRef>,
        force: bool,
    ) -> Option<wire::SessionAgents> {
        let tasks = sessions
            .iter()
            .map(|entry| (entry.session_id.clone(), entry.task_id.clone()))
            .collect();
        self.commit_agents_alive(sessions, &tasks, force)
    }

    /// `sessions` is the process-detected list; `alive` the snapshot it was scanned from.
    fn commit_agents_alive(
        &self,
        sessions: Vec<wire::SessionAgentRef>,
        alive: &AliveTasks,
        force: bool,
    ) -> Option<wire::SessionAgents> {
        let mut inner = self.inner.lock().unwrap();
        let sessions = merge_annotations(&mut inner, sessions, alive);
        if !force && !inner.agents_delivery_dirty && inner.last_reported_agents == sessions {
            return None;
        }
        inner.last_reported_agents = sessions.clone();
        inner.agents_delivery_dirty = false;
        Some(wire::SessionAgents { sessions })
    }
}

/// 全量计算每个存活会话的监听端口；按 sessionId、port 排序，保证可稳定比较。
/// Device `ports.request` 复用这份纯扫描，但不读写 observer 的上报缓存。
pub(crate) fn scan_ports(alive: &SessionProcesses) -> Vec<wire::SessionPorts> {
    let mut sessions: Vec<wire::SessionPorts> = alive
        .iter()
        .filter_map(|(session_id, (_task_id, pid))| {
            let mut found: Vec<u16> = ports::listening_ports(*pid).into_iter().collect();
            if found.is_empty() {
                return None;
            }
            found.sort_unstable();
            Some(wire::SessionPorts {
                session_id: session_id.clone(),
                ports: found.into_iter().map(u32::from).collect(),
            })
        })
        .collect();
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    sessions
}

/// presence 扫描是 annotation 的存活门：本轮没扫到的 session 立即剪枝。
///
/// The entries are the process-detected ones plus every alive session holding an OSC 7501
/// record. State and message come only from the record (none = `""`, no message); the record
/// also names the agent. Progress and the agent session id come from their own channels.
/// Records of sessions no longer alive are dropped.
fn merge_annotations(
    inner: &mut ObservedInner,
    mut sessions: Vec<wire::SessionAgentRef>,
    alive: &AliveTasks,
) -> Vec<wire::SessionAgentRef> {
    inner
        .program_status
        .retain(|session_id, _| alive.contains_key(session_id));
    {
        let detected: HashSet<&str> = sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        let reported: Vec<wire::SessionAgentRef> = inner
            .program_status
            .keys()
            .filter(|session_id| !detected.contains(session_id.as_str()))
            .map(|session_id| wire::SessionAgentRef {
                session_id: session_id.clone(),
                task_id: alive.get(session_id).cloned().unwrap_or_default(),
                agent: String::new(),
                state: String::new(),
                message: String::new(),
                progress: String::new(),
                agent_session_id: String::new(),
            })
            .collect();
        sessions.extend(reported);
    }
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    {
        let present: HashSet<&str> = sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        inner
            .hook_progress
            .retain(|session_id, _| present.contains(session_id.as_str()));
        inner
            .hook_agent_sessions
            .retain(|session_id, _| present.contains(session_id.as_str()));
    }

    for entry in &mut sessions {
        if let Some(record) = inner.program_status.get(&entry.session_id) {
            entry.state = program_presence_state(record).to_string();
            entry.message = match record.state {
                ProgramState::Blocked | ProgramState::Error => record.message.clone(),
                _ => String::new(),
            };
            entry.agent = program_agent(&record.app, &entry.agent);
        }
        if let Some(progress) = inner.hook_progress.get(&entry.session_id) {
            entry.progress = progress.clone();
        }
        if let Some(agent_session_id) = inner.hook_agent_sessions.get(&entry.session_id) {
            entry.agent_session_id = agent_session_id.clone();
        }
    }
    sessions
}

/// The presence state a program status record stands for; `""` = present but idle.
fn program_presence_state(record: &ProgramStatus) -> &'static str {
    match (record.state, record.kind) {
        (ProgramState::Working, _) => "active",
        (ProgramState::Blocked, Some(BlockedKind::Question)) => "question",
        (ProgramState::Blocked, _) => "approval",
        (ProgramState::Done, _) => "done",
        (ProgramState::Error, _) => "error",
        (ProgramState::Idle, _) => "",
    }
}

/// The agent name for a record: the program's own `app`, sanitised (control characters dropped,
/// clamped on a character boundary, `claude-code` read as `claude`); without one, the name
/// process detection found, else a generic one.
fn program_agent(app: &str, detected: &str) -> String {
    let mut name: String = app.chars().filter(|c| !c.is_control()).collect();
    if name.len() > MAX_PROGRAM_APP_BYTES {
        let mut end = MAX_PROGRAM_APP_BYTES;
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        name.truncate(end);
    }
    let name = name.trim();
    if name == "claude-code" {
        return "claude".into();
    }
    if !name.is_empty() {
        return name.to_string();
    }
    if !detected.is_empty() {
        return detected.to_string();
    }
    UNNAMED_PROGRAM_AGENT.into()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

    fn ports(session_id: &str, values: &[u32]) -> Vec<wire::SessionPorts> {
        vec![wire::SessionPorts {
            session_id: session_id.into(),
            ports: values.to_vec(),
        }]
    }

    fn agents(session_id: &str) -> Vec<wire::SessionAgentRef> {
        vec![wire::SessionAgentRef {
            session_id: session_id.into(),
            task_id: format!("task-{session_id}"),
            agent: "claude".into(),
            state: String::new(),
            message: String::new(),
            progress: String::new(),
            agent_session_id: String::new(),
        }]
    }

    #[test]
    fn 相同快照只上报一次且_force_刷新比较基准() {
        let observed = ObservedState::new();

        assert!(observed.commit_ports(Vec::new(), false).is_none());
        assert!(observed.commit_ports(Vec::new(), true).is_some());
        assert!(observed.commit_ports(Vec::new(), false).is_none());
        assert!(observed.commit_ports(ports("s1", &[3000]), false).is_some());
        assert!(observed.commit_ports(ports("s1", &[3000]), false).is_none());
        assert!(observed.commit_ports(ports("s2", &[4000]), true).is_some());
        assert!(observed.commit_ports(ports("s2", &[4000]), false).is_none());

        assert!(observed.commit_agents(Vec::new(), false).is_none());
        assert!(observed.commit_agents(Vec::new(), true).is_some());
        assert!(observed.commit_agents(agents("s1"), false).is_some());
        assert!(observed.commit_agents(agents("s1"), false).is_none());
        assert!(observed.commit_agents(agents("s2"), true).is_some());
        assert!(observed.commit_agents(agents("s2"), false).is_none());
    }

    /// Without an OSC 7501 record a process-detected entry has no state and no message; progress
    /// is its own channel, replaced by the latest value and pruned with the entry.
    #[test]
    fn detected_entry_without_a_record_has_no_state_and_keeps_progress() {
        let observed = ObservedState::new();
        observed.apply_progress("s1".into(), "正在定位".into());

        let first = observed
            .commit_agents(agents("s1"), false)
            .expect("a new entry is reported");
        assert!(first.sessions[0].state.is_empty());
        assert!(first.sessions[0].message.is_empty());
        assert_eq!(first.sessions[0].progress, "正在定位");

        observed.apply_progress("s1".into(), "正在回归".into());
        let second = observed
            .commit_agents(agents("s1"), false)
            .expect("new progress replaces the old");
        assert!(second.sessions[0].state.is_empty());
        assert_eq!(second.sessions[0].progress, "正在回归");

        assert!(observed.commit_agents(Vec::new(), false).is_some());
        let returned = observed
            .commit_agents(agents("s1"), false)
            .expect("a returning agent is reported");
        assert!(returned.sessions[0].state.is_empty());
        assert!(returned.sessions[0].progress.is_empty());
    }

    /// The agent session id lives like `progress`, not like the turn state: a state change must
    /// not evaporate it (a Claude session keeps the same transcript across every turn), while the
    /// presence entry disappearing takes it with it.
    #[test]
    fn agent_session_id_跨_hook_事件存活且随条目剪枝() {
        let observed = ObservedState::new();
        observed.apply_agent_session_id("s1".into(), "6fd5b5f9-959b".into());

        let first = observed
            .commit_agents(agents("s1"), false)
            .expect("新增 agent session id 应上报");
        assert_eq!(first.sessions[0].agent_session_id, "6fd5b5f9-959b");

        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, "", "")),
        );
        let second = observed
            .commit_agents(agents("s1"), false)
            .expect("a state change is reported");
        assert_eq!(second.sessions[0].state, "active");
        assert_eq!(second.sessions[0].agent_session_id, "6fd5b5f9-959b");

        // `/clear` 换了新会话：只有 id 变了，state 不动——比较必须看得见这一次变化。
        observed.apply_agent_session_id("s1".into(), "aaaabbbb-cccc".into());
        let third = observed
            .commit_agents(agents("s1"), false)
            .expect("只有 id 变也应上报");
        assert_eq!(third.sessions[0].agent_session_id, "aaaabbbb-cccc");

        assert!(observed.commit_agents(Vec::new(), false).is_some());
        let returned = observed
            .commit_agents(agents("s1"), false)
            .expect("agent 再出现应上报");
        assert!(returned.sessions[0].agent_session_id.is_empty());
    }

    #[tokio::test]
    async fn ports_与_agents_扫描_lane_互不阻塞() {
        let observed = ObservedState::new();
        let _ports = observed.ports_scan_lane.lock().await;

        let agents = tokio::time::timeout(
            Duration::from_secs(1),
            observed.scan_agents_with(|| HashMap::new(), false, |_| agents("s1")),
        )
        .await
        .expect("ports lane 不应阻塞 agent 扫描");
        assert!(agents.is_some());
    }

    #[tokio::test]
    async fn 等待_lane_期间不提前截取_alive_快照() {
        let observed = Arc::new(ObservedState::new());
        let lane = observed.ports_scan_lane.lock().await;
        let snapshot_taken = Arc::new(AtomicBool::new(false));

        let mut scan = {
            let observed = observed.clone();
            let snapshot_taken = snapshot_taken.clone();
            tokio::spawn(async move {
                observed
                    .scan_ports_with(
                        move || {
                            snapshot_taken.store(true, Ordering::Release);
                            HashMap::new()
                        },
                        true,
                        |_| ports("current", &[3000]),
                    )
                    .await
                    .map(|report| {
                        let value = report.value().clone();
                        report.acknowledge();
                        value
                    })
            })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut scan)
                .await
                .is_err(),
            "持有 ports lane 时扫描不应完成"
        );
        assert!(
            !snapshot_taken.load(Ordering::Acquire),
            "alive 必须在取得同类 scan lane 后才截取"
        );

        drop(lane);
        let report = scan.await.unwrap().expect("force 扫描应返回快照");
        assert_eq!(report.sessions[0].session_id, "current");
    }

    #[tokio::test]
    async fn 同类_scan_lane_持有到调用方完成_enqueue() {
        let observed = Arc::new(ObservedState::new());
        let first = observed
            .scan_agents_with(|| HashMap::new(), true, |_| agents("old"))
            .await
            .expect("force 扫描应返回快照");
        let second_snapshot_taken = Arc::new(AtomicBool::new(false));

        let mut second = {
            let observed = observed.clone();
            let second_snapshot_taken = second_snapshot_taken.clone();
            tokio::spawn(async move {
                observed
                    .scan_agents_with(
                        move || {
                            second_snapshot_taken.store(true, Ordering::Release);
                            HashMap::new()
                        },
                        true,
                        |_| agents("new"),
                    )
                    .await
                    .map(|report| {
                        let value = report.value().clone();
                        report.acknowledge();
                        value
                    })
            })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut second)
                .await
                .is_err(),
            "第一份 report 尚未 drop 时第二份扫描不应完成"
        );
        assert!(
            !second_snapshot_taken.load(Ordering::Acquire),
            "第一份 report 尚未 enqueue/drop 时，第二份同类扫描不能开始"
        );

        assert_eq!(first.value().sessions[0].session_id, "old");
        first.acknowledge();
        let second = second.await.unwrap().expect("第二份 force 扫描应完成");
        assert_eq!(second.sessions[0].session_id, "new");
        let inner = observed.inner.lock().unwrap();
        assert_eq!(inner.last_reported_agents[0].session_id, "new");
    }

    #[tokio::test]
    async fn 周期_enqueue_失败后相同_ports_快照会重试() {
        let observed = ObservedState::new();
        let first = observed
            .scan_ports_with(|| HashMap::new(), false, |_| ports("s1", &[3000]))
            .await
            .expect("首次变化应上报");
        let cancelled = async move {
            let _report = first;
            std::future::pending::<()>().await;
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(10), cancelled)
                .await
                .is_err(),
            "模拟 enqueue await 中途取消"
        );

        let retry = observed
            .scan_ports_with(|| HashMap::new(), false, |_| ports("s1", &[3000]))
            .await
            .expect("失败后相同快照必须重试");
        retry.acknowledge();
        assert!(
            observed
                .scan_ports_with(|| HashMap::new(), false, |_| ports("s1", &[3000]),)
                .await
                .is_none(),
            "成功 enqueue 后才恢复去重"
        );
    }

    #[tokio::test]
    async fn force_enqueue_失败后普通_agents_扫描会重试() {
        let observed = ObservedState::new();
        let baseline = observed
            .scan_agents_with(|| HashMap::new(), false, |_| agents("s1"))
            .await
            .expect("首次变化应上报");
        baseline.acknowledge();

        let forced = observed
            .scan_agents_with(|| HashMap::new(), true, |_| agents("s1"))
            .await
            .expect("force 必须上报");
        drop(forced);

        let retry = observed
            .scan_agents_with(|| HashMap::new(), false, |_| agents("s1"))
            .await
            .expect("force enqueue 失败后普通扫描必须补发");
        assert_eq!(retry.value().sessions[0].session_id, "s1");
        retry.acknowledge();
    }

    fn record(
        state: ProgramState,
        kind: Option<BlockedKind>,
        app: &str,
        message: &str,
    ) -> ProgramStatus {
        ProgramStatus {
            state,
            kind,
            app: app.into(),
            message: message.into(),
        }
    }

    fn alive(session_ids: &[&str]) -> AliveTasks {
        session_ids
            .iter()
            .map(|session_id| (session_id.to_string(), format!("task-{session_id}")))
            .collect()
    }

    /// The single entry committed for `s1` with `detected` as the process-detected list and
    /// only `s1` alive.
    fn committed(
        observed: &ObservedState,
        detected: Vec<wire::SessionAgentRef>,
    ) -> wire::SessionAgentRef {
        let report = observed
            .commit_agents_alive(detected, &alive(&["s1"]), true)
            .expect("force always reports");
        assert_eq!(report.sessions.len(), 1, "{:?}", report.sessions);
        report.sessions.into_iter().next().unwrap()
    }

    #[test]
    fn program_status_record_maps_to_presence() {
        let cases = [
            (
                record(ProgramState::Working, None, "pi", ""),
                "pi",
                "active",
                "",
            ),
            (
                record(
                    ProgramState::Blocked,
                    Some(BlockedKind::Auth),
                    "pi",
                    "Log in",
                ),
                "pi",
                "approval",
                "Log in",
            ),
            (
                record(
                    ProgramState::Blocked,
                    Some(BlockedKind::Permission),
                    "pi",
                    "",
                ),
                "pi",
                "approval",
                "",
            ),
            (
                record(ProgramState::Blocked, None, "pi", ""),
                "pi",
                "approval",
                "",
            ),
            (
                record(
                    ProgramState::Blocked,
                    Some(BlockedKind::Question),
                    "pi",
                    "Apply?",
                ),
                "pi",
                "question",
                "Apply?",
            ),
            (
                record(ProgramState::Error, None, "pi", "boom"),
                "pi",
                "error",
                "boom",
            ),
            (
                record(ProgramState::Done, None, "pi", "ignored"),
                "pi",
                "done",
                "",
            ),
            (record(ProgramState::Idle, None, "pi", ""), "pi", "", ""),
            (
                record(ProgramState::Working, None, "claude-code", ""),
                "claude",
                "active",
                "",
            ),
            (
                record(ProgramState::Working, None, "", ""),
                "agent",
                "active",
                "",
            ),
            (
                record(ProgramState::Working, None, "a\u{7}b", ""),
                "ab",
                "active",
                "",
            ),
        ];
        for (status, agent, state, message) in cases {
            let observed = ObservedState::new();
            observed.apply_program_status("s1".into(), Some(status.clone()));
            let entry = committed(&observed, Vec::new());
            assert_eq!(entry.session_id, "s1");
            assert_eq!(entry.task_id, "task-s1", "task id from the alive snapshot");
            assert_eq!(
                (
                    entry.agent.as_str(),
                    entry.state.as_str(),
                    entry.message.as_str()
                ),
                (agent, state, message),
                "{status:?}"
            );
        }

        // Empty app on a process-detected session keeps the detected name.
        let observed = ObservedState::new();
        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, "", "")),
        );
        let mut codex = agents("s1");
        codex[0].agent = "codex".into();
        assert_eq!(committed(&observed, codex).agent, "codex");

        // A long app is clamped to 32 bytes on a character boundary.
        let observed = ObservedState::new();
        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, &"x".repeat(40), "")),
        );
        assert_eq!(committed(&observed, Vec::new()).agent, "x".repeat(32));
        let observed = ObservedState::new();
        let wide = format!("{}é", "x".repeat(31));
        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, &wide, "")),
        );
        assert_eq!(committed(&observed, Vec::new()).agent, "x".repeat(31));
    }

    #[test]
    fn program_status_record_alone_decides_state() {
        let observed = ObservedState::new();
        observed.apply_agent_session_id("s1".into(), "6fd5b5f9".into());
        observed.apply_progress("s1".into(), "step 2".into());
        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, "pi", "")),
        );

        let entry = committed(&observed, agents("s1"));
        assert_eq!(entry.state, "active");
        assert_eq!(entry.agent, "pi");
        assert_eq!(
            entry.agent_session_id, "6fd5b5f9",
            "survives alongside a record"
        );
        assert_eq!(entry.progress, "step 2", "survives alongside a record");

        // The record removed: the detected entry stays, with no state.
        observed.apply_program_status("s1".into(), None);
        let entry = committed(&observed, agents("s1"));
        assert_eq!(entry.state, "");
        assert!(entry.message.is_empty());
        assert_eq!(entry.agent, "claude");
        assert_eq!(entry.agent_session_id, "6fd5b5f9");
    }

    #[test]
    fn program_status_records_follow_the_alive_set() {
        let observed = ObservedState::new();
        observed.apply_program_status(
            "s1".into(),
            Some(record(ProgramState::Working, None, "pi", "")),
        );
        observed.apply_program_status(
            "s2".into(),
            Some(record(ProgramState::Done, None, "pi", "")),
        );
        let report = observed
            .commit_agents_alive(Vec::new(), &alive(&["s1", "s2"]), true)
            .unwrap();
        let ids: Vec<&str> = report
            .sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s1", "s2"], "sorted by session id");

        // s2 left the alive set: its record goes with it and does not come back.
        let report = observed
            .commit_agents_alive(Vec::new(), &alive(&["s1"]), true)
            .unwrap();
        assert_eq!(report.sessions.len(), 1);
        let report = observed
            .commit_agents_alive(Vec::new(), &alive(&["s1", "s2"]), true)
            .unwrap();
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session_id, "s1");

        // A process-detected entry and a record on another session are merged and sorted.
        let mut detected = agents("s0");
        detected[0].task_id = "task-s0".into();
        let report = observed
            .commit_agents_alive(detected, &alive(&["s0", "s1"]), true)
            .unwrap();
        let ids: Vec<&str> = report
            .sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s0", "s1"]);
    }
}
