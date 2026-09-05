/**
 * daemon 认证/登记时宣告的控制面能力名（plan 091）。中心按能力名而不是 worker 版本号做门禁：
 * dev/测试的 worker 上报 `builtin`，仓库的自动升级也刻意不做 semver 比较；而旧 worker 对未知
 * ServerToDaemon 载荷是静默丢弃的——不设门禁，agent 会白等到超时且没有任何可读原因。
 *
 * 能力名是协议契约的一部分，与 crates/worker/src/main.rs 的常量保持一致；新增控制消息时同步加名字。
 */

/** 认识 PreparedDeviceOperationExecute：中心可触发已安装 prepared 操作的执行（建/删 worktree、建会话）。 */
export const DAEMON_CAPABILITY_PREPARED_EXECUTE = "prepared_execute";
/** 认识 ServerAgentRequest：中心可经 daemon 读命令日志/快照、往终端写输入。 */
export const DAEMON_CAPABILITY_TERMINAL_IO = "terminal_io";
/** 认识 ServerAgentRequest 的 terminal_notify / terminal_progress 分支（plan 093）：中心可替 agent 给
 * 自己所在终端的 presence 打「叫人」留言与进度短评。刻意不复用 terminal_io：旧 worker 收到新分支只会回
 * 「未知的中心请求动作」，而不是这里约定的「需要升级」。 */
export const DAEMON_CAPABILITY_AGENT_ANNOTATE = "agent_annotate";

/** 写 tool 在缺失能力时返回的可读错误；SKILL/文档里以「需要升级」一词指代它。 */
export function daemonUpgradeRequired(deviceName: string): string {
  return `该设备的 daemon 需要升级（${deviceName}）：在该设备上运行 \`cofluxd update && cofluxd restart\` 后重试`;
}
