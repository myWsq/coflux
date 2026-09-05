//! 会话账本（plan 094）：worker 本地掌握的每个会话的归属与生死，供 agent 本地命令
//! （send / read / wait / notify / progress）做归属校验与退出码查询——这些操作本地能闭环，不问中心。
//!
//! 来源只有两处：中心随 SessionCreate（直发与 prepared 两条路径，plan 092 起带 `workspace_id`）
//! 下发的会话归属，以及 worker 自己经手的 SessionStarted / SessionExit。热升级后新 worker 从
//! sessiond 对账清单学来的存活会话没有 `workspace_id`（空串 = 归属未知）——对它们的本地命令一律
//! 可读拒绝，**不按 cwd 猜**：那是第二份可能与中心不一致的推断（plans/094 Decisions）。
//!
//! 与 `WorkerState.alive` 分开：alive 被 presence/端口扫描与 079 对账逻辑按 (task_id, pid) 精确
//! 匹配，账本只消费它的生命周期事件，不改它的形状。

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 会话生命周期；`wait`/`read` 据此报 status 与退出码。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionPhase {
    /// 中心已下发建会话，sessiond 尚未回 started
    Pending,
    Running,
    Exited { exit_code: i32 },
}

#[derive(Clone, Debug)]
pub(crate) struct SessionRecord {
    pub task_id: String,
    /// 空串 = 归属未知
    pub workspace_id: String,
    pub phase: SessionPhase,
    exited_at: Option<Instant>,
}

/// 已退出条目的保留上限：agent 通常在退出后几秒到几分钟内 wait/read，24 小时或 512 条之外的
/// 丢最旧的。拍脑袋值——若反馈「跑完很久的终端 wait 说不存在」，先看这里。
const MAX_EXITED_RECORDS: usize = 512;
const EXITED_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub(crate) struct SessionLedger {
    by_session: HashMap<String, SessionRecord>,
    /// task -> 最近一次的 session（task 重启会换 session，agent 按 task 寻址）
    by_task: HashMap<String, String>,
}

impl SessionLedger {
    /// 中心下发建会话：登记归属。同一 session 重复 create（prepared 重放）只补归属，不回退 phase。
    pub fn remember_create(&mut self, session_id: &str, task_id: &str, workspace_id: &str) {
        if session_id.is_empty() || task_id.is_empty() {
            return;
        }
        match self.by_session.get_mut(session_id) {
            Some(existing) => {
                existing.task_id = task_id.to_string();
                if !workspace_id.is_empty() {
                    existing.workspace_id = workspace_id.to_string();
                }
            }
            None => {
                self.by_session.insert(
                    session_id.to_string(),
                    SessionRecord {
                        task_id: task_id.to_string(),
                        workspace_id: workspace_id.to_string(),
                        phase: SessionPhase::Pending,
                        exited_at: None,
                    },
                );
            }
        }
        self.by_task
            .insert(task_id.to_string(), session_id.to_string());
    }

    /// sessiond 回 started / 对账清单里的存活会话：转 Running。账本里没有的补一条（归属未知）。
    pub fn mark_started(&mut self, session_id: &str, task_id: &str) {
        if session_id.is_empty() {
            return;
        }
        let entry = self
            .by_session
            .entry(session_id.to_string())
            .or_insert_with(|| SessionRecord {
                task_id: task_id.to_string(),
                workspace_id: String::new(),
                phase: SessionPhase::Pending,
                exited_at: None,
            });
        if !task_id.is_empty() {
            entry.task_id = task_id.to_string();
        }
        entry.phase = SessionPhase::Running;
        entry.exited_at = None;
        if !entry.task_id.is_empty() {
            let task_id = entry.task_id.clone();
            self.by_task.insert(task_id, session_id.to_string());
        }
    }

    /// sessiond 对账清单：清单里的会话都在跑；账本里没有的补一条（归属未知）。
    pub fn learn_alive<'a>(&mut self, sessions: impl IntoIterator<Item = (&'a str, &'a str)>) {
        for (session_id, task_id) in sessions {
            self.mark_started(session_id, task_id);
        }
    }

    /// 精确 control exit 与 catalog tombstone 共用：只对已知会话记退出码，未知的不凭空造条目。
    pub fn mark_exited(&mut self, session_id: &str, exit_code: i32) {
        let Some(entry) = self.by_session.get_mut(session_id) else {
            return;
        };
        entry.phase = SessionPhase::Exited { exit_code };
        entry.exited_at = Some(Instant::now());
        self.prune();
    }

    /// 建会话失败（从未 started）：条目作废，按 task 寻址得到「不存在」。
    pub fn forget(&mut self, session_id: &str) {
        if let Some(record) = self.by_session.remove(session_id) {
            if self
                .by_task
                .get(&record.task_id)
                .is_some_and(|current| current == session_id)
            {
                self.by_task.remove(&record.task_id);
            }
        }
    }

    pub fn session(&self, session_id: &str) -> Option<&SessionRecord> {
        self.by_session.get(session_id)
    }

    /// 按 task 找最近一次的 session。
    pub fn task(&self, task_id: &str) -> Option<(&str, &SessionRecord)> {
        let session_id = self.by_task.get(task_id)?;
        let record = self.by_session.get(session_id)?;
        Some((session_id.as_str(), record))
    }

    fn prune(&mut self) {
        let now = Instant::now();
        let stale: Vec<String> = self
            .by_session
            .iter()
            .filter(|(_, record)| {
                record
                    .exited_at
                    .is_some_and(|at| now.duration_since(at) > EXITED_RETENTION)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in stale {
            self.forget(&session_id);
        }
        let mut exited: Vec<(String, Instant)> = self
            .by_session
            .iter()
            .filter_map(|(session_id, record)| record.exited_at.map(|at| (session_id.clone(), at)))
            .collect();
        if exited.len() > MAX_EXITED_RECORDS {
            exited.sort_by_key(|(_, at)| *at);
            let over = exited.len() - MAX_EXITED_RECORDS;
            for (session_id, _) in exited.into_iter().take(over) {
                self.forget(&session_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_started_exited_flow_keeps_workspace_and_exit_code() {
        let mut ledger = SessionLedger::default();
        ledger.remember_create("s1", "t1", "ws-a");
        assert_eq!(ledger.session("s1").unwrap().phase, SessionPhase::Pending);
        ledger.mark_started("s1", "t1");
        assert_eq!(ledger.session("s1").unwrap().phase, SessionPhase::Running);
        assert_eq!(ledger.task("t1").unwrap().0, "s1");
        ledger.mark_exited("s1", 7);
        let (_, record) = ledger.task("t1").unwrap();
        assert_eq!(record.phase, SessionPhase::Exited { exit_code: 7 });
        assert_eq!(record.workspace_id, "ws-a", "退出后归属仍可查（wait/read 在退出后调用）");
    }

    #[test]
    fn started_without_create_has_unknown_workspace() {
        let mut ledger = SessionLedger::default();
        ledger.mark_started("s-legacy", "t-legacy");
        let record = ledger.session("s-legacy").unwrap();
        assert_eq!(record.phase, SessionPhase::Running);
        assert!(record.workspace_id.is_empty(), "对账学来的会话归属未知，不许猜");
        // 迟到的 create（prepared 重放）补上归属但不把 Running 打回 Pending
        ledger.remember_create("s-legacy", "t-legacy", "ws-b");
        let record = ledger.session("s-legacy").unwrap();
        assert_eq!(record.workspace_id, "ws-b");
        assert_eq!(record.phase, SessionPhase::Running);
    }

    #[test]
    fn task_index_follows_latest_session_and_forget_clears_it() {
        let mut ledger = SessionLedger::default();
        ledger.remember_create("s-old", "t1", "ws");
        ledger.mark_started("s-old", "t1");
        ledger.mark_exited("s-old", 0);
        ledger.remember_create("s-new", "t1", "ws");
        assert_eq!(ledger.task("t1").unwrap().0, "s-new", "task 重启后按 task 找到新 session");
        ledger.forget("s-old");
        assert_eq!(ledger.task("t1").unwrap().0, "s-new", "忘掉旧 session 不能误删新索引");
        ledger.forget("s-new");
        assert!(ledger.task("t1").is_none());
    }

    #[test]
    fn exited_records_are_bounded() {
        let mut ledger = SessionLedger::default();
        for i in 0..(MAX_EXITED_RECORDS + 50) {
            let session = format!("s{i}");
            ledger.remember_create(&session, &format!("t{i}"), "ws");
            ledger.mark_started(&session, &format!("t{i}"));
            ledger.mark_exited(&session, 0);
        }
        let exited = ledger
            .by_session
            .values()
            .filter(|record| matches!(record.phase, SessionPhase::Exited { .. }))
            .count();
        assert!(exited <= MAX_EXITED_RECORDS, "已退出条目必须有界: {exited}");
        let last = format!("t{}", MAX_EXITED_RECORDS + 49);
        assert!(ledger.task(&last).is_some(), "最新退出的必须还在");
    }

    #[test]
    fn unknown_exit_does_not_create_records() {
        let mut ledger = SessionLedger::default();
        ledger.mark_exited("ghost", 1);
        assert!(ledger.session("ghost").is_none());
    }
}
