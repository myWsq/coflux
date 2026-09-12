//! The executor run ledger: the very small job table between `coflux executor run` and the desktop
//! app.
//!
//! **The daemon does exactly three things on this path**: recognize the machine's single executor
//! host, push assignments to it, and store the states and terminal outcomes it reports for the CLI
//! to poll. Scheduling, the write lock, transcripts and model calls all live in the desktop main
//! process — worker memory is lost on hot upgrade (see the command-log index comment in
//! `crates/worker/src/main.rs`), so putting the job table here would put what most needs to survive
//! in the place most likely to vanish.
//!
//! **Failure boundaries (fixed; do not relax them)**:
//! - A dropped channel does not mean the app died. **Never re-dispatch a writer** — an expired lease
//!   does not prove the old writer stopped, and re-dispatching is a double write.
//! - After a host generation change (app restart / channel reconnect), go through **reconciliation**:
//!   the daemon names the runs it still has unfinished and the host re-reports each one. Anything not
//!   re-reported in time becomes `Unknown` (result unknown) — not a failure, and certainly not a rerun.
//! - When another desktop instance claims the host slot, every unfinished run under the previous host
//!   becomes `Unknown` immediately: the new instance has no way to know whether the old one is still
//!   writing.
//!
//! This module is a pure state machine (it takes `now` rather than reading a clock, and does no I/O):
//! the caller receives [`Effect`]s and sends the frames itself.

use std::collections::{BTreeMap, HashMap};

/// The capability name a host must declare when registering. Gated by name, with no version
/// comparison, following `apps/server/src/daemon-capabilities.ts`: old clients drop unknown payloads
/// silently, so having no gate would only leave the agent waiting for a timeout.
pub const CAPABILITY_EXECUTOR_HOST: &str = "executor_host_v1";

/// The window a host gets to re-report after a disconnect or a generation change. Anything still
/// not re-reported when it closes becomes `Unknown`. 45s is the same order as the lease TTL: enough
/// for the app to reconnect once, without leaving the CLI waiting too long.
pub const RECONCILE_GRACE_MS: f64 = 45_000.0;
/// How long to wait for a host to accept after an assignment is pushed. When the host is present but
/// silent (a wedged main process), the run must not sit in queued forever.
pub const ASSIGN_ACK_MS: f64 = 30_000.0;
/// How many runs the ledger keeps. Past the cap, the oldest **finished** run is evicted first; when
/// they are all still running, new submissions are refused.
pub const MAX_RUNS: usize = 64;
/// Byte cap for one prompt: the executor's input is a task description, not a file channel.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    /// Registered and pushed to the host, with no acceptance receipt yet.
    Queued,
    /// The host accepted it.
    Accepted,
    /// The host reported it running.
    Running,
    /// Finished; `terminal` is always set.
    Done,
}

/// Terminal-state classification. A process exiting 0, or `prompt()` returning, **must not** be
/// taken for success on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Terminal {
    Succeeded,
    /// The host refused on the spot: write lock taken, no provider/model configured, concurrency cap
    /// reached, and so on. `note` carries the reason, written for the agent.
    Rejected,
    ModelError,
    ToolFailed,
    Cancelled,
    /// Result unknown: the host dropped or changed generation and never re-reported. **Never rerun
    /// automatically.**
    Unknown,
}

impl Terminal {
    /// The stable strings the CLI and the SKILL expose.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Rejected => "rejected",
            Self::ModelError => "model_error",
            Self::ToolFailed => "tool_failed",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }

    /// Only `Succeeded` counts as success; everything else must make the CLI exit non-zero.
    pub fn ok(self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

impl RunPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Done => "done",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RunRecord {
    pub run_id: String,
    pub submission_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub write: bool,
    pub prompt: String,
    pub phase: RunPhase,
    pub terminal: Option<Terminal>,
    /// One in-flight sentence, or the reason for a refusal.
    pub note: String,
    pub summary: String,
    pub changed_files: Vec<String>,
    pub error: String,
    pub host_id: String,
    pub host_epoch: u64,
    pub cancel_requested: bool,
    pub created_at: f64,
    pub updated_at: f64,
    /// Without a message from the host by this instant, the run becomes `Unknown`. None means no
    /// timer is running (the host is present and the run is going).
    pub deadline: Option<f64>,
}

impl RunRecord {
    pub fn done(&self) -> bool {
        self.phase == RunPhase::Done
    }
}

#[derive(Clone, Debug)]
pub struct HostRecord {
    pub channel_id: String,
    pub host_id: String,
    pub epoch: u64,
    pub ready: bool,
    pub not_ready_reason: String,
}

/// The frames the ledger asks its caller to send. The ledger itself touches no I/O.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Assign { channel_id: String, run_id: String },
    Cancel { channel_id: String, run_id: String },
    ReportAck { channel_id: String, run_id: String },
}

// `reconcile_deadline` is epoch milliseconds as f64, following the repository's existing convention
// (see `now_ms: f64` in local_auth.rs), and f64 has no Eq — hence PartialEq only, without Eq.
#[derive(Clone, Debug, PartialEq)]
pub struct RegisterOutcome {
    /// The runs the host must re-report one by one (reconnect reconciliation).
    pub reconcile_run_ids: Vec<String>,
    pub reconcile_deadline: f64,
}

#[derive(Default)]
pub struct ExecutorLedger {
    host: Option<HostRecord>,
    runs: BTreeMap<String, RunRecord>,
    by_submission: HashMap<String, String>,
    next_seq: u64,
}

impl ExecutorLedger {
    pub fn host(&self) -> Option<&HostRecord> {
        self.host.as_ref()
    }

    pub fn run(&self, run_id: &str) -> Option<&RunRecord> {
        self.runs.get(run_id)
    }

    /// Register or update the machine's executor host.
    ///
    /// A lower epoch for the same host_id is stale (a late registration from an old connection) and
    /// is refused outright. A different host_id takes over, and every unfinished run under the
    /// previous host becomes `Unknown` — the new instance has no way to know whether the old one is
    /// still writing.
    pub fn register_host(
        &mut self,
        channel_id: &str,
        host_id: &str,
        epoch: u64,
        capabilities: &[String],
        ready: bool,
        not_ready_reason: &str,
        now: f64,
    ) -> Result<RegisterOutcome, String> {
        if host_id.trim().is_empty() || epoch == 0 {
            return Err("executor host 身份无效（hostId/hostEpoch 必填）".into());
        }
        if !capabilities
            .iter()
            .any(|name| name == CAPABILITY_EXECUTOR_HOST)
        {
            return Err(format!(
                "executor host 未声明能力 {CAPABILITY_EXECUTOR_HOST}：请升级 Coflux.app"
            ));
        }
        if let Some(current) = &self.host {
            if current.host_id == host_id && epoch < current.epoch {
                return Err("executor host 登记已过期（更高 epoch 已在位）".into());
            }
            if current.host_id != host_id {
                self.fail_runs_of_other_host(host_id, now);
            }
        }
        self.host = Some(HostRecord {
            channel_id: channel_id.to_string(),
            host_id: host_id.to_string(),
            epoch,
            ready,
            not_ready_reason: not_ready_reason.to_string(),
        });
        let deadline = now + RECONCILE_GRACE_MS;
        let mut reconcile_run_ids = Vec::new();
        for record in self.runs.values_mut() {
            if record.done() || record.host_id != host_id {
                continue;
            }
            record.host_epoch = epoch;
            record.deadline = Some(deadline);
            reconcile_run_ids.push(record.run_id.clone());
        }
        Ok(RegisterOutcome {
            reconcile_run_ids,
            reconcile_deadline: deadline,
        })
    }

    /// The host's channel is gone (the caller noticed it left the channels table). **No
    /// re-dispatch**, only a timer: if no new host re-reports before it expires, these runs become
    /// `Unknown`.
    pub fn host_channel_lost(&mut self, now: f64) {
        let Some(host) = self.host.take() else { return };
        let deadline = now + RECONCILE_GRACE_MS;
        for record in self.runs.values_mut() {
            if record.done() || record.host_id != host.host_id {
                continue;
            }
            record.deadline = Some(deadline);
            if record.note.is_empty() {
                record.note = "桌面 app 的连接中断，等待它重连后重报".into();
            }
        }
    }

    fn fail_runs_of_other_host(&mut self, new_host_id: &str, now: f64) {
        for record in self.runs.values_mut() {
            if record.done() || record.host_id == new_host_id {
                continue;
            }
            finish(
                record,
                Terminal::Unknown,
                "另一个 Coflux.app 实例接管了本机 executor，本任务结果未知（不会自动重跑）",
                now,
            );
        }
    }

    /// Settle expirations: any run past its deadline with no message becomes `Unknown`. Called before
    /// every read of or write to the ledger.
    pub fn sweep(&mut self, now: f64) {
        for record in self.runs.values_mut() {
            if record.done() {
                continue;
            }
            let Some(deadline) = record.deadline else {
                continue;
            };
            if now < deadline {
                continue;
            }
            finish(
                record,
                Terminal::Unknown,
                "桌面 app 没有在限期内回报本任务的状态，结果未知（不会自动重跑）",
                now,
            );
        }
    }

    /// Submit a run. The same submission_id arriving again returns the same run — this is what
    /// deduplicates the CLI's retry after a submission timeout.
    #[allow(clippy::too_many_arguments)]
    pub fn submit(
        &mut self,
        submission_id: &str,
        workspace_id: &str,
        workspace_root: &str,
        prompt: &str,
        write: bool,
        now: f64,
    ) -> Result<(String, Option<Effect>), String> {
        self.sweep(now);
        if submission_id.trim().is_empty() {
            return Err("executor.submit 缺 submissionId".into());
        }
        if prompt.trim().is_empty() {
            return Err("executor.submit 缺 prompt".into());
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(format!(
                "executor.submit prompt 超过 {MAX_PROMPT_BYTES} 字节上限"
            ));
        }
        if let Some(run_id) = self.by_submission.get(submission_id) {
            // A retry: return the existing runId and never dispatch twice (the executor has side
            // effects).
            return Ok((run_id.clone(), None));
        }
        let Some(host) = self.host.clone() else {
            return Err(
                "本机 Coflux.app 没在跑（executor 由桌面 app 执行）：打开 Coflux.app 后重试".into(),
            );
        };
        if !host.ready {
            let reason = if host.not_ready_reason.trim().is_empty() {
                "Coflux.app 还没配置 executor 的模型：在账号菜单的「Executor 设置…」里填 provider / model / API key".to_string()
            } else {
                host.not_ready_reason.clone()
            };
            return Err(reason);
        }
        if workspace_root.trim().is_empty() {
            return Err("本工作区在 daemon 里没有已登记的本地路径，executor 无法确定边界".into());
        }
        self.evict_if_needed()?;
        self.next_seq = self.next_seq.saturating_add(1);
        let run_id = format!("run-{}-{}", std::process::id(), self.next_seq);
        let record = RunRecord {
            run_id: run_id.clone(),
            submission_id: submission_id.to_string(),
            workspace_id: workspace_id.to_string(),
            workspace_root: workspace_root.to_string(),
            write,
            prompt: prompt.to_string(),
            phase: RunPhase::Queued,
            terminal: None,
            note: String::new(),
            summary: String::new(),
            changed_files: Vec::new(),
            error: String::new(),
            host_id: host.host_id.clone(),
            host_epoch: host.epoch,
            cancel_requested: false,
            created_at: now,
            updated_at: now,
            deadline: Some(now + ASSIGN_ACK_MS),
        };
        self.by_submission
            .insert(submission_id.to_string(), run_id.clone());
        self.runs.insert(run_id.clone(), record);
        Ok((
            run_id.clone(),
            Some(Effect::Assign {
                channel_id: host.channel_id,
                run_id,
            }),
        ))
    }

    /// Cancel, idempotently. A run nobody accepted yet goes straight to `Cancelled` (with no taker,
    /// cancelling cannot cause a double write); an accepted one only gets a flag and a cancel frame,
    /// and the real terminal state still comes from the host.
    pub fn cancel(&mut self, run_id: &str, now: f64) -> Result<Option<Effect>, String> {
        self.sweep(now);
        let channel_id = self.host.as_ref().map(|host| host.channel_id.clone());
        let Some(record) = self.runs.get_mut(run_id) else {
            return Err("没有这条 executor 任务（runId 不对或已被淘汰）".into());
        };
        if record.done() {
            return Ok(None);
        }
        record.cancel_requested = true;
        record.updated_at = now;
        if record.phase == RunPhase::Queued {
            finish(record, Terminal::Cancelled, "提交后在接单前被取消", now);
            return Ok(None);
        }
        Ok(channel_id.map(|channel_id| Effect::Cancel {
            channel_id,
            run_id: run_id.to_string(),
        }))
    }

    /// Consume one report from the host. Returns the ack to send back; only terminal states are
    /// acked, because that ack is what lets the host drop its local copy.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_report(
        &mut self,
        host_id: &str,
        host_epoch: u64,
        run_id: &str,
        state: ReportState,
        note: &str,
        summary: &str,
        changed_files: Vec<String>,
        error: &str,
        now: f64,
    ) -> Option<Effect> {
        let channel_id = self.host.as_ref().map(|host| host.channel_id.clone());
        let record = self.runs.get_mut(run_id)?;
        if record.host_id != host_id || host_epoch < record.host_epoch {
            return None;
        }
        record.host_epoch = host_epoch;
        record.updated_at = now;
        if !note.is_empty() {
            record.note = note.to_string();
        }
        match state {
            ReportState::Accepted | ReportState::Running => {
                if record.done() {
                    // An in-flight report arriving after a terminal state: do not revive it, do not ack.
                    return None;
                }
                record.phase = if state == ReportState::Accepted {
                    RunPhase::Accepted
                } else {
                    RunPhase::Running
                };
                // The host is alive and reporting, so clear the timer; it is re-armed on a disconnect
                // or a generation change.
                record.deadline = None;
                None
            }
            ReportState::Terminal(terminal) => {
                if !record.done() {
                    if !summary.is_empty() {
                        record.summary = summary.to_string();
                    }
                    if !changed_files.is_empty() {
                        record.changed_files = changed_files;
                    }
                    if !error.is_empty() {
                        record.error = error.to_string();
                    }
                    finish(record, terminal, note, now);
                }
                // Re-reporting the same terminal state still gets an ack: a lost ack makes the host
                // resend forever.
                channel_id.map(|channel_id| Effect::ReportAck {
                    channel_id,
                    run_id: run_id.to_string(),
                })
            }
        }
    }

    /// When the ledger is full, evict the oldest **finished** run first; if none can be freed, refuse
    /// the new submission rather than displacing a running task.
    fn evict_if_needed(&mut self) -> Result<(), String> {
        while self.runs.len() >= MAX_RUNS {
            let oldest = self
                .runs
                .values()
                .filter(|record| record.done())
                .min_by(|left, right| left.updated_at.total_cmp(&right.updated_at))
                .map(|record| (record.run_id.clone(), record.submission_id.clone()));
            let Some((run_id, submission_id)) = oldest else {
                return Err("executor 在跑的任务已达上限，等它们结束后再提交".into());
            };
            self.runs.remove(&run_id);
            self.by_submission.remove(&submission_id);
        }
        Ok(())
    }
}

/// The state a host reports; the wire enum maps to it in [`report_state_from_wire`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportState {
    Accepted,
    Running,
    Terminal(Terminal),
}

/// The wire's `ExecutorRunState` -> a ledger state. Unknown values map to None rather than panicking.
pub fn report_state_from_wire(value: i32) -> Option<ReportState> {
    use coflux_protocol::wire::ExecutorRunState as Wire;
    match Wire::try_from(value).ok()? {
        Wire::Unspecified => None,
        Wire::Accepted => Some(ReportState::Accepted),
        Wire::Running => Some(ReportState::Running),
        Wire::Succeeded => Some(ReportState::Terminal(Terminal::Succeeded)),
        Wire::Rejected => Some(ReportState::Terminal(Terminal::Rejected)),
        Wire::ModelError => Some(ReportState::Terminal(Terminal::ModelError)),
        Wire::ToolFailed => Some(ReportState::Terminal(Terminal::ToolFailed)),
        Wire::Cancelled => Some(ReportState::Terminal(Terminal::Cancelled)),
        Wire::Unknown => Some(ReportState::Terminal(Terminal::Unknown)),
    }
}

fn finish(record: &mut RunRecord, terminal: Terminal, note: &str, now: f64) {
    record.phase = RunPhase::Done;
    record.terminal = Some(terminal);
    record.deadline = None;
    record.updated_at = now;
    if !note.is_empty() {
        record.note = note.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> Vec<String> {
        vec![CAPABILITY_EXECUTOR_HOST.to_string()]
    }

    fn ledger_with_host(now: f64) -> ExecutorLedger {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-1", "host-a", 1, &caps(), true, "", now)
            .expect("登记成功");
        ledger
    }

    fn submit(ledger: &mut ExecutorLedger, submission: &str, write: bool, now: f64) -> String {
        ledger
            .submit(submission, "ws-1", "/repo", "清掉 clippy 警告", write, now)
            .expect("提交成功")
            .0
    }

    #[test]
    fn host_must_declare_the_capability_by_name() {
        let mut ledger = ExecutorLedger::default();
        let refused = ledger
            .register_host("ch-1", "host-a", 1, &[], true, "", 0.0)
            .expect_err("缺能力名必须拒");
        assert!(refused.contains(CAPABILITY_EXECUTOR_HOST), "{refused}");
        assert!(ledger.host().is_none());
    }

    #[test]
    fn submitting_without_a_host_is_refused_readably_not_queued() {
        let mut ledger = ExecutorLedger::default();
        let refused = ledger
            .submit("sub-1", "ws-1", "/repo", "干活", true, 0.0)
            .expect_err("没有 host 必须立刻拒");
        assert!(refused.contains("Coflux.app"), "{refused}");
    }

    #[test]
    fn unconfigured_host_is_refused_at_submit_time_with_its_own_reason() {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-1", "host-a", 1, &caps(), false, "去桌面配 provider", 0.0)
            .expect("登记成功");
        let refused = ledger
            .submit("sub-1", "ws-1", "/repo", "干活", true, 0.0)
            .expect_err("未配置必须立刻拒");
        assert_eq!(refused, "去桌面配 provider");
    }

    #[test]
    fn same_submission_id_never_dispatches_twice() {
        let mut ledger = ledger_with_host(0.0);
        let (first, effect) = ledger
            .submit("sub-1", "ws-1", "/repo", "干活", true, 0.0)
            .unwrap();
        assert_eq!(
            effect,
            Some(Effect::Assign {
                channel_id: "ch-1".into(),
                run_id: first.clone()
            })
        );
        let (second, effect) = ledger
            .submit("sub-1", "ws-1", "/repo", "干活", true, 1.0)
            .unwrap();
        assert_eq!(second, first, "重投必须回同一条 run");
        assert_eq!(effect, None, "重投绝不二次派发");
    }

    #[test]
    fn a_queued_run_that_is_never_accepted_becomes_unknown_not_stuck() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.sweep(ASSIGN_ACK_MS - 1.0);
        assert_eq!(ledger.run(&run_id).unwrap().phase, RunPhase::Queued);
        ledger.sweep(ASSIGN_ACK_MS);
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Unknown));
        assert!(!record.terminal.unwrap().ok());
    }

    #[test]
    fn running_reports_clear_the_deadline_so_long_tasks_are_not_killed() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Running,
            "跑测试中",
            "",
            Vec::new(),
            "",
            1.0,
        );
        ledger.sweep(3_600_000.0);
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.phase, RunPhase::Running);
        assert_eq!(record.note, "跑测试中");
    }

    #[test]
    fn terminal_reports_are_acked_and_repeated_ones_are_acked_again() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        let ack = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "改完了",
            vec!["src/a.rs".into()],
            "",
            2.0,
        );
        assert_eq!(
            ack,
            Some(Effect::ReportAck {
                channel_id: "ch-1".into(),
                run_id: run_id.clone()
            })
        );
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Succeeded));
        assert_eq!(record.summary, "改完了");
        assert_eq!(record.changed_files, vec!["src/a.rs".to_string()]);
        // A lost ack makes the host resend the same terminal state: ack it again, and do not change
        // the outcome already recorded.
        let again = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "被覆盖的新文案",
            Vec::new(),
            "",
            3.0,
        );
        assert!(again.is_some());
        assert_eq!(ledger.run(&run_id).unwrap().summary, "改完了");
    }

    #[test]
    fn reconnecting_host_gets_a_reconcile_list_and_unreported_runs_fall_to_unknown() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Running,
            "",
            "",
            Vec::new(),
            "",
            1.0,
        );
        ledger.host_channel_lost(10.0);
        // Reconnect after a generation change: get the reconcile list.
        let outcome = ledger
            .register_host("ch-2", "host-a", 2, &caps(), true, "", 20.0)
            .expect("重连登记成功");
        assert_eq!(outcome.reconcile_run_ids, vec![run_id.clone()]);
        assert_eq!(outcome.reconcile_deadline, 20.0 + RECONCILE_GRACE_MS);
        // Not re-reported: unknown once the deadline passes, and **no re-dispatch** (no new Assign
        // effect).
        ledger.sweep(20.0 + RECONCILE_GRACE_MS);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Unknown)
        );
    }

    #[test]
    fn a_reconnected_host_that_reports_running_keeps_the_run_alive() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.host_channel_lost(10.0);
        ledger
            .register_host("ch-2", "host-a", 2, &caps(), true, "", 20.0)
            .unwrap();
        ledger.apply_report(
            "host-a",
            2,
            &run_id,
            ReportState::Running,
            "还在跑",
            "",
            Vec::new(),
            "",
            21.0,
        );
        ledger.sweep(20.0 + RECONCILE_GRACE_MS + 1.0);
        assert_eq!(ledger.run(&run_id).unwrap().phase, RunPhase::Running);
    }

    #[test]
    fn another_desktop_instance_never_inherits_the_old_hosts_runs() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger
            .register_host("ch-9", "host-b", 1, &caps(), true, "", 5.0)
            .expect("另一个实例可以接管 host");
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Unknown), "不得重派 writer");
        assert!(record.note.contains("结果未知"), "{}", record.note);
    }

    #[test]
    fn stale_epoch_registration_is_refused() {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-2", "host-a", 5, &caps(), true, "", 0.0)
            .unwrap();
        let refused = ledger
            .register_host("ch-1", "host-a", 4, &caps(), true, "", 1.0)
            .expect_err("较低 epoch 是 stale");
        assert!(refused.contains("过期"), "{refused}");
        assert_eq!(ledger.host().unwrap().channel_id, "ch-2");
    }

    #[test]
    fn stale_epoch_reports_are_dropped() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger
            .register_host("ch-2", "host-a", 2, &caps(), true, "", 1.0)
            .unwrap();
        let ack = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "旧代的终态",
            Vec::new(),
            "",
            2.0,
        );
        assert_eq!(ack, None);
        assert!(ledger.run(&run_id).unwrap().terminal.is_none());
    }

    #[test]
    fn cancel_is_idempotent_and_only_pushes_a_frame_once_accepted() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        // Not accepted yet: record cancelled locally, push no frame.
        assert_eq!(ledger.cancel(&run_id, 1.0).unwrap(), None);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Cancelled)
        );
        // Cancelling after a terminal state is a no-op.
        assert_eq!(ledger.cancel(&run_id, 2.0).unwrap(), None);

        let second = submit(&mut ledger, "sub-2", true, 3.0);
        ledger.apply_report(
            "host-a",
            1,
            &second,
            ReportState::Accepted,
            "",
            "",
            Vec::new(),
            "",
            4.0,
        );
        assert_eq!(
            ledger.cancel(&second, 5.0).unwrap(),
            Some(Effect::Cancel {
                channel_id: "ch-1".into(),
                run_id: second.clone()
            })
        );
        assert!(!ledger.run(&second).unwrap().done(), "终态仍由 host 报");
        // A repeated cancel only pushes the frame again; the state does not change.
        assert!(ledger.cancel(&second, 6.0).unwrap().is_some());
    }

    #[test]
    fn unknown_run_ids_and_oversized_prompts_are_refused() {
        let mut ledger = ledger_with_host(0.0);
        assert!(ledger.cancel("run-nope", 0.0).is_err());
        let long = "x".repeat(MAX_PROMPT_BYTES + 1);
        let refused = ledger
            .submit("sub-1", "ws-1", "/repo", &long, true, 0.0)
            .expect_err("超长 prompt 必须拒");
        assert!(refused.contains("上限"), "{refused}");
        let refused = ledger
            .submit("sub-2", "ws-1", "/repo", "   ", true, 0.0)
            .expect_err("空 prompt 必须拒");
        assert!(refused.contains("prompt"), "{refused}");
    }

    #[test]
    fn full_ledger_evicts_finished_runs_before_refusing() {
        let mut ledger = ledger_with_host(0.0);
        for index in 0..MAX_RUNS {
            let run_id = submit(&mut ledger, &format!("sub-{index}"), false, index as f64);
            ledger.apply_report(
                "host-a",
                1,
                &run_id,
                ReportState::Terminal(Terminal::Succeeded),
                "",
                "",
                Vec::new(),
                "",
                index as f64,
            );
        }
        // All finished: evict the oldest and let the new submission through as usual.
        let fresh = submit(&mut ledger, "sub-fresh", false, 1_000.0);
        assert!(ledger.run(&fresh).is_some());
        assert!(ledger.runs.len() <= MAX_RUNS);
    }

    #[test]
    fn terminal_names_are_stable_for_the_cli_and_skill() {
        assert_eq!(Terminal::Succeeded.as_str(), "succeeded");
        assert_eq!(Terminal::Rejected.as_str(), "rejected");
        assert_eq!(Terminal::ModelError.as_str(), "model_error");
        assert_eq!(Terminal::ToolFailed.as_str(), "tool_failed");
        assert_eq!(Terminal::Cancelled.as_str(), "cancelled");
        assert_eq!(Terminal::Unknown.as_str(), "unknown");
        assert!(Terminal::Succeeded.ok());
        for terminal in [
            Terminal::Rejected,
            Terminal::ModelError,
            Terminal::ToolFailed,
            Terminal::Cancelled,
            Terminal::Unknown,
        ] {
            assert!(!terminal.ok(), "{} 不该算成功", terminal.as_str());
        }
    }

    #[test]
    fn wire_states_map_onto_the_ledger_and_unknown_values_are_ignored() {
        use coflux_protocol::wire::ExecutorRunState as Wire;
        assert_eq!(
            report_state_from_wire(Wire::Running as i32),
            Some(ReportState::Running)
        );
        assert_eq!(
            report_state_from_wire(Wire::ToolFailed as i32),
            Some(ReportState::Terminal(Terminal::ToolFailed))
        );
        assert_eq!(report_state_from_wire(Wire::Unspecified as i32), None);
        assert_eq!(report_state_from_wire(9999), None);
    }
}
