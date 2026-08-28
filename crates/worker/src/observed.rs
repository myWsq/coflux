//! daemon 派生观测状态：会话端口、agent presence，以及 presence 上的本地 annotation。
//!
//! 本模块不拥有 session catalog：`alive` 的权威仍是 supervisor/sessiond，调用方只把
//! `WorkerState` 中的瞬时快照传进来。这里仅负责阻塞扫描、全量快照去重和重连时的强制补发
//! 基准；同样不感知认证、WebSocket 生命周期或出站队列。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use coflux_protocol::wire;
use tokio::sync::Mutex as AsyncMutex;

use crate::{agents, ports};

pub(crate) type SessionProcesses = HashMap<String, (String, i32)>;

#[derive(Default)]
struct ObservedInner {
    last_reported_ports: Vec<wire::SessionPorts>,
    last_reported_agents: Vec<wire::SessionAgentRef>,
    ports_delivery_dirty: bool,
    agents_delivery_dirty: bool,
    hook_states: HashMap<String, &'static str>,
    hook_messages: HashMap<String, String>,
    hook_progress: HashMap<String, String>,
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

    /// hook 事件代表 agent 已换回合：更新状态并清掉上一条 notify，progress 刻意保留。
    pub(crate) fn apply_hook_state(&self, session_id: String, state: &'static str) {
        let mut inner = self.inner.lock().unwrap();
        inner.hook_states.insert(session_id.clone(), state);
        inner.hook_messages.remove(&session_id);
    }

    /// notify 是一个原子 annotation：presence 同时转为 question 并携带留言。
    pub(crate) fn apply_notify(&self, session_id: String, message: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.hook_states.insert(session_id.clone(), "question");
        inner.hook_messages.insert(session_id, message);
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
        let sessions = tokio::task::spawn_blocking(move || scan(&alive))
            .await
            .ok()?;
        let value = self.commit_agents(sessions, force)?;
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

    fn commit_agents(
        &self,
        sessions: Vec<wire::SessionAgentRef>,
        force: bool,
    ) -> Option<wire::SessionAgents> {
        let mut inner = self.inner.lock().unwrap();
        let sessions = merge_annotations(&mut inner, sessions);
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
fn merge_annotations(
    inner: &mut ObservedInner,
    mut sessions: Vec<wire::SessionAgentRef>,
) -> Vec<wire::SessionAgentRef> {
    {
        let present: HashSet<&str> = sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        inner
            .hook_states
            .retain(|session_id, _| present.contains(session_id.as_str()));
        inner
            .hook_messages
            .retain(|session_id, _| present.contains(session_id.as_str()));
        inner
            .hook_progress
            .retain(|session_id, _| present.contains(session_id.as_str()));
    }

    for entry in &mut sessions {
        if let Some(state) = inner.hook_states.get(&entry.session_id) {
            entry.state = (*state).to_string();
        }
        if let Some(message) = inner.hook_messages.get(&entry.session_id) {
            entry.message = message.clone();
        }
        if let Some(progress) = inner.hook_progress.get(&entry.session_id) {
            entry.progress = progress.clone();
        }
    }
    sessions
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

    #[test]
    fn hook_清留言保留进度且_presence_消失会剪枝() {
        let observed = ObservedState::new();
        observed.apply_notify("s1".into(), "需要你决定".into());
        observed.apply_progress("s1".into(), "正在定位".into());

        let first = observed
            .commit_agents(agents("s1"), false)
            .expect("annotation 变化应上报");
        assert_eq!(first.sessions[0].state, "question");
        assert_eq!(first.sessions[0].message, "需要你决定");
        assert_eq!(first.sessions[0].progress, "正在定位");

        observed.apply_hook_state("s1".into(), "active");
        let second = observed
            .commit_agents(agents("s1"), false)
            .expect("hook 变化应上报");
        assert_eq!(second.sessions[0].state, "active");
        assert!(second.sessions[0].message.is_empty());
        assert_eq!(second.sessions[0].progress, "正在定位");

        observed.apply_progress("s1".into(), "正在回归".into());
        let third = observed
            .commit_agents(agents("s1"), false)
            .expect("新 progress 应覆盖旧值");
        assert_eq!(third.sessions[0].state, "active");
        assert!(third.sessions[0].message.is_empty());
        assert_eq!(third.sessions[0].progress, "正在回归");

        assert!(observed.commit_agents(Vec::new(), false).is_some());
        let returned = observed
            .commit_agents(agents("s1"), false)
            .expect("agent 再出现应上报");
        assert!(returned.sessions[0].state.is_empty());
        assert!(returned.sessions[0].message.is_empty());
        assert!(returned.sessions[0].progress.is_empty());
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
}
