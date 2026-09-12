//! executor run 账本（plan 116）：`coflux executor run` 与桌面 app 之间那张极小的作业表。
//!
//! **daemon 在这条链路上只做三件事**：认下本机唯一的 executor host、把工单推给它、把它回报的
//! 状态与终态存着供 CLI 轮询。调度、写锁、转录、模型调用全在桌面主进程——worker 的内存态热升级
//! 即丢（见 `crates/worker/src/main.rs` 的命令日志索引注释），把作业表放这里等于把最需要活下来的
//! 东西放在最容易消失的地方。
//!
//! **故障边界（写死，不得放宽）**：
//! - channel 断了不等于 app 死了。**绝不重派 writer**——租约失效不证明旧 writer 已停止，重派就是双写。
//! - host 换代（app 重启 / 通道重连）后走**对账**：daemon 报出手里仍未终结的 run，host 逐条重报；
//!   到点没被重报的判 `Unknown`（结果未知），不是失败、更不是重跑。
//! - 另一个桌面实例抢注成 host 时，上一个 host 名下未终结的 run 立刻判 `Unknown`：新实例无从
//!   知道旧实例是否还在写。
//!
//! 本模块是纯状态机（只吃 `now` 不读时钟、不做 I/O）：调用方拿到 [`Effect`] 后自己发帧。

use std::collections::{BTreeMap, HashMap};

/// host 必须在登记时报出的能力名。按名门禁，不比较版本号——对齐
/// `apps/server/src/daemon-capabilities.ts` 的范式：旧客户端对未知载荷是静默丢弃的，
/// 不设门禁只会让 agent 白等到超时。
pub const CAPABILITY_EXECUTOR_HOST: &str = "executor_host_v1";

/// host 掉线 / 换代后给它重报的窗口。到点仍未重报即判 `Unknown`。
/// 45s 与 lease TTL 同量级：足够 app 重连一次，又不至于让 CLI 干等太久。
pub const RECONCILE_GRACE_MS: f64 = 45_000.0;
/// 工单推出去之后等 host 接单的上限。host 在但不吭声（主进程卡死）时，run 不能永远停在 queued。
pub const ASSIGN_ACK_MS: f64 = 30_000.0;
/// 账本里最多留多少条 run。超出时先淘汰最老的**已终结** run；全是在跑的就拒绝新提交。
pub const MAX_RUNS: usize = 64;
/// 单条 prompt 的字节上限：executor 的入参是一句任务描述，不是文件通道。
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    /// 已登记、工单已推给 host，还没收到接单回执
    Queued,
    /// host 已接单
    Accepted,
    /// host 报了 running
    Running,
    /// 已终结，`terminal` 必有值
    Done,
}

/// 终态分类（plan 116）：**不得**把「进程退出 0」或「prompt() 返回」直接当成功。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Terminal {
    Succeeded,
    /// host 当场拒绝：写锁被占、未配置 provider/model、并发封顶……`note` 是给 agent 看的原因
    Rejected,
    ModelError,
    ToolFailed,
    Cancelled,
    /// 结果未知：host 掉线 / 换代后没能重报。**绝不自动重跑**
    Unknown,
}

impl Terminal {
    /// CLI 与 SKILL 里露出的稳定字符串。
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

    /// 只有 `Succeeded` 算成功；其余都要让 CLI 以非零退出码结束。
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
    /// 发起方会话（只作归属与排错线索，不参与鉴权——鉴权在 `/agent` 的 pid 反查那道门）
    pub session_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub write: bool,
    pub prompt: String,
    pub phase: RunPhase,
    pub terminal: Option<Terminal>,
    /// 进行中的一句话 / 拒绝原因
    pub note: String,
    pub summary: String,
    pub changed_files: Vec<String>,
    pub error: String,
    pub host_id: String,
    pub host_epoch: u64,
    pub cancel_requested: bool,
    pub created_at: f64,
    pub updated_at: f64,
    /// 到这个时刻还没等到 host 的消息就判 `Unknown`。None = 不计时（host 在、run 在跑）。
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

/// 账本要调用方替它发出去的帧。账本自己不碰 I/O。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Assign { channel_id: String, run_id: String },
    Cancel { channel_id: String, run_id: String },
    ReportAck { channel_id: String, run_id: String },
}

// `reconcile_deadline` 是 epoch 毫秒、按仓库既有约定用 f64（见 local_auth.rs 的 `now_ms: f64`），
// 而 f64 没有 Eq——故这里只 derive PartialEq，不 derive Eq。
#[derive(Clone, Debug, PartialEq)]
pub struct RegisterOutcome {
    /// 需要 host 逐条重报的 run（重连对账）
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

    /// 登记 / 更新本机 executor host。
    ///
    /// 同 host_id 的较低 epoch 是 stale（旧连接的迟到登记），直接拒；换了 host_id 则接管，
    /// 并把上一个 host 名下未终结的 run 全部判 `Unknown`——新实例无从知道旧实例是否还在写。
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

    /// host 的通道没了（调用方发现 channel 已不在 channels 表里）。**不重派**，只开始计时：
    /// 到点仍没有新 host 重报，这些 run 落 `Unknown`。
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

    /// 到点清算：把超过 deadline 仍没等到消息的 run 判 `Unknown`。每次读写账本前调用。
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

    /// 提交一条 run。同 submission_id 重投返回同一条 run（CLI 的提交超时重发就靠它去重）。
    #[allow(clippy::too_many_arguments)]
    pub fn submit(
        &mut self,
        submission_id: &str,
        session_id: &str,
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
            // 重投：只回已有 runId，绝不二次派发（executor 有副作用）
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
            session_id: session_id.to_string(),
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

    /// 取消：幂等。还没被接单的直接落 `Cancelled`（工单没人接，取消不会造成双写）；
    /// 已接单的只置位并推一条取消帧，真正的终态仍由 host 报。
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

    /// 消化 host 的一条回报。返回要回给 host 的 ack（只有终态才 ack——host 靠它才敢丢掉本地副本）。
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
                    // 终态之后迟到的进行中回报：不复活，也不 ack。
                    return None;
                }
                record.phase = if state == ReportState::Accepted {
                    RunPhase::Accepted
                } else {
                    RunPhase::Running
                };
                // host 还活着且在报，取消计时器；掉线/换代时再重新装上。
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
                // 重复上报同一终态也要 ack：ack 丢了 host 会一直重发。
                channel_id.map(|channel_id| Effect::ReportAck {
                    channel_id,
                    run_id: run_id.to_string(),
                })
            }
        }
    }

    /// 账本满了先淘汰最老的**已终结** run；一条都腾不出来就拒绝新提交，不挤掉在跑的任务。
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

/// host 回报的状态；wire 枚举到它的映射在 [`report_state_from_wire`]。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportState {
    Accepted,
    Running,
    Terminal(Terminal),
}

/// wire 的 `ExecutorRunState` → 账本状态。未知值按 None 处理而非 panic。
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
            .submit(submission, "s1", "ws-1", "/repo", "清掉 clippy 警告", write, now)
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
            .submit("sub-1", "s1", "ws-1", "/repo", "干活", true, 0.0)
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
            .submit("sub-1", "s1", "ws-1", "/repo", "干活", true, 0.0)
            .expect_err("未配置必须立刻拒");
        assert_eq!(refused, "去桌面配 provider");
    }

    #[test]
    fn same_submission_id_never_dispatches_twice() {
        let mut ledger = ledger_with_host(0.0);
        let (first, effect) = ledger
            .submit("sub-1", "s1", "ws-1", "/repo", "干活", true, 0.0)
            .unwrap();
        assert_eq!(
            effect,
            Some(Effect::Assign {
                channel_id: "ch-1".into(),
                run_id: first.clone()
            })
        );
        let (second, effect) = ledger
            .submit("sub-1", "s1", "ws-1", "/repo", "干活", true, 1.0)
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
        // ack 丢了 host 会重发同一条终态：必须再 ack 一次，且不改已落的结果
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
        // 换代重连：拿到对账清单
        let outcome = ledger
            .register_host("ch-2", "host-a", 2, &caps(), true, "", 20.0)
            .expect("重连登记成功");
        assert_eq!(outcome.reconcile_run_ids, vec![run_id.clone()]);
        assert_eq!(outcome.reconcile_deadline, 20.0 + RECONCILE_GRACE_MS);
        // 没重报：到点判 unknown，且**不重派**（没有新的 Assign effect）
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
        // 还没接单：本地直接落 cancelled，不推帧
        assert_eq!(ledger.cancel(&run_id, 1.0).unwrap(), None);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Cancelled)
        );
        // 已终结后再取消是空操作
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
        // 重复取消仍然只是再推一次帧，状态不变
        assert!(ledger.cancel(&second, 6.0).unwrap().is_some());
    }

    #[test]
    fn unknown_run_ids_and_oversized_prompts_are_refused() {
        let mut ledger = ledger_with_host(0.0);
        assert!(ledger.cancel("run-nope", 0.0).is_err());
        let long = "x".repeat(MAX_PROMPT_BYTES + 1);
        let refused = ledger
            .submit("sub-1", "s1", "ws-1", "/repo", &long, true, 0.0)
            .expect_err("超长 prompt 必须拒");
        assert!(refused.contains("上限"), "{refused}");
        let refused = ledger
            .submit("sub-2", "s1", "ws-1", "/repo", "   ", true, 0.0)
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
        // 全是已终结的：淘汰最老的那条，新提交照常通过
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
