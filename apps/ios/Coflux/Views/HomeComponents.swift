import CofluxClientCore
import CofluxProtocol
import SwiftUI

// Building blocks shared by the compact home (WorkspaceListView) and the split sidebar
// (HomeSidebar): avatars and the workspace activity line. The sections themselves are in
// HomeSections.swift.

/// An agent's mark in a rounded square, with an optional state dot on its corner.
struct AgentAvatar: View {
    enum Mark {
        case agent(String)
        case secret
    }

    let mark: Mark
    var size: CGFloat = 34
    var dot: Color?
    /// Claude's mark is Clawd, in this pose (the desktop's tab glyph).
    var clawd: ClawdPose = .idle

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.32)
            .fill(Theme.accentSurface)
            .frame(width: size, height: size)
            .overlay { glyph }
            .overlay(alignment: .topTrailing) {
                if let dot {
                    Circle()
                        .fill(dot)
                        .frame(width: size * 0.34, height: size * 0.34)
                        .overlay(Circle().strokeBorder(Theme.card, lineWidth: 2))
                        .offset(x: size * 0.1, y: -size * 0.1)
                }
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var glyph: some View {
        switch mark {
        case .secret:
            Image(systemName: "key.fill")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Theme.warning)
        case .agent(let name):
            switch name.lowercased() {
            case "":
                Image(systemName: "terminal")
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Theme.mutedForeground)
            case "claude":
                ClawdGlyph(pose: clawd, size: min(size * 0.7, ClawdSheet.renderedGlyphSize))
            case "codex":
                Text(">_")
                    .font(.system(size: size * 0.38, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.foreground)
            default:
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.46, weight: .bold))
                    .foregroundStyle(Theme.foreground)
            }
        }
    }
}

/// The row line of a workspace: which agent sets its state, the state's tone and the subtitle.
struct WorkspaceActivity {
    enum Tone {
        case waiting
        case active
        case done
        case idle
        case failed

        var color: Color {
            switch self {
            case .waiting: Theme.warning
            case .active: Theme.success
            case .done: Theme.info
            case .idle: Theme.mutedForeground
            case .failed: Theme.destructive
            }
        }
    }

    /// The agent shown on the row (nil: no agent, the row shows the branch icon).
    let agent: String?
    /// That agent's turn state (`SessionAgentRef.state`); a pending secret request counts as
    /// waiting for approval.
    let agentState: String?
    /// The centre's account-wide seen mark on that agent's finished turn
    /// (`SessionAgentRef.seen`, plan 20261111-agent-seen-sync).
    let agentSeen: Bool
    let tone: Tone
    let subtitle: String
    /// The terminal the row opens: the one that waits, else the agent's, else nil (keep the last).
    let taskID: String?
    /// How much the workspace asks of the user, for a collapsed project's summary: 5 approval or
    /// a secret request, 4 question, 3 error, 2 active, 1 done, 0 nothing. 3 and above wait for
    /// the user (待处理).
    let rank: Int

    @MainActor
    init(_ workspace: Coflux_V1_Workspace, client: CofluxClient) {
        let tasks = client.tasks.filter { $0.workspaceID == workspace.id }
        let running = tasks.filter { $0.status == .running }
        let progress = client.workspaceProgress(workspaceID: workspace.id)
        var best: (task: Coflux_V1_Task, ref: Coflux_V1_SessionAgentRef, rank: Int)?
        for task in running {
            guard let ref = client.agent(forTask: task) else { continue }
            let rank = switch ref.state {
            case "approval": 5
            case "question": 4
            case "error": 3
            case "active": 2
            case "done", "waiting": 1
            default: 0
            }
            if best == nil || rank > best!.rank { best = (task, ref, rank) }
        }
        func joined(_ head: String, _ tail: String?) -> String {
            guard let tail, !tail.isEmpty else { return head }
            return "\(head) · \(tail)"
        }
        if let secret = client.pendingSecretRequest(workspaceID: workspace.id) {
            agent = best?.ref.agent
            agentState = "approval"
            agentSeen = false
            tone = .waiting
            subtitle = "等待输入 \(secret.name)"
            taskID = secret.taskID
            rank = 5
        } else if let best, best.rank >= 1 {
            agent = best.ref.agent
            agentState = best.ref.state
            agentSeen = best.ref.seen
            taskID = best.task.id
            rank = best.rank
            let message = best.ref.message.isEmpty ? nil : best.ref.message
            switch best.rank {
            case 5:
                tone = .waiting
                subtitle = joined("等待批准", message)
            case 4:
                tone = .waiting
                subtitle = joined("等待回答", message)
            case 3:
                tone = .failed
                subtitle = joined("出错了", message)
            case 2:
                tone = .active
                subtitle = joined("正在执行", progress)
            default:
                tone = .done
                subtitle = joined("本轮完成", progress)
            }
        } else {
            agent = best?.ref.agent
            agentState = best?.ref.state
            agentSeen = best?.ref.seen ?? false
            taskID = best?.task.id
            rank = 0
            if tasks.isEmpty {
                tone = .idle
                subtitle = "暂无终端"
            } else if running.isEmpty {
                tone = .idle
                subtitle = "\(tasks.count) 个终端 · 空闲"
            } else {
                tone = best == nil ? .idle : .active
                subtitle = joined("\(running.count) 个终端运行中", progress)
            }
        }
    }
}

/// One terminal's state line, in the words and tones of the home rows (等待批准 / 正在执行 /
/// 本轮完成 …): the terminal page's switcher and its menu show it under the terminal's name.
struct TerminalActivity {
    let tone: WorkspaceActivity.Tone
    let text: String

    @MainActor
    init(_ task: Coflux_V1_Task, client: CofluxClient) {
        func joined(_ head: String, _ tail: String?) -> String {
            guard let tail, !tail.isEmpty else { return head }
            return "\(head) · \(tail)"
        }
        if let secret = client.pendingSecretRequests(taskID: task.id).first {
            tone = .waiting
            text = "等待输入 \(secret.name)"
            return
        }
        switch task.status {
        case .running:
            break
        case .exited:
            tone = task.exitCode == 0 ? .idle : .failed
            text = task.exitCode == 0 ? "已退出" : "已退出 · 代码 \(task.exitCode)"
            return
        default:
            tone = .idle
            text = "未启动"
            return
        }
        let ref = client.agent(forTask: task)
        let message = ref.map(\.message).flatMap { $0.isEmpty ? nil : $0 }
        let progress = ref.map(\.progress).flatMap { $0.isEmpty ? nil : $0 }
        switch ref?.state {
        case "approval":
            tone = .waiting
            text = joined("等待批准", message)
        case "question":
            tone = .waiting
            text = joined("等待回答", message)
        case "active":
            tone = .active
            text = joined("正在执行", progress)
        case "done", "waiting":
            tone = .done
            text = joined("本轮完成", progress)
        case "error":
            tone = .failed
            text = joined("出错了", message)
        default:
            tone = .idle
            text = ref.map { $0.agent.isEmpty ? "运行中" : "\($0.agent) · 空闲" } ?? "运行中"
        }
    }
}

extension Coflux_V1_Workspace {
    /// Row title: the branch (directory workspaces have none and fall back to the name).
    var displayTitle: String {
        branch.isEmpty ? name : branch
    }

    /// The grey label after the title: a custom name, or 主工作区 for an unnamed main workspace.
    var customLabel: String? {
        if !name.isEmpty, name != branch { return name }
        return isMain ? "主工作区" : nil
    }
}

/// `+N −M` of a workspace, hidden when both are zero.
struct DiffStat: View {
    let additions: Int32
    let deletions: Int32

    var body: some View {
        if additions != 0 || deletions != 0 {
            HStack(spacing: 4) {
                Text("+\(additions)").foregroundStyle(Theme.success)
                Text("−\(deletions)").foregroundStyle(Theme.destructive)
            }
            .font(Theme.Fonts.meta.monospacedDigit().weight(.medium))
        }
    }
}

/// A workspace row's content, shared by the sidebar and the outer display's home so they read the
/// same: the icon, the name (with its custom label when there is room), and the state line closed
/// on the right by the diff (user's call, 2026-11-09).
struct WorkspaceRowContent: View {
    let workspace: Coflux_V1_Workspace
    let activity: WorkspaceActivity
    var showsLabel = true

    var body: some View {
        HStack(spacing: 10) {
            WorkspaceRowIcon(workspace: workspace, activity: activity)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(workspace.displayTitle)
                        .font(Theme.Fonts.rowTitle)
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    if showsLabel, let label = workspace.customLabel {
                        Text(label)
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.subtleForeground)
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 6) {
                    Text(activity.subtitle)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(activity.tone.color)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    DiffStat(additions: workspace.additions, deletions: workspace.deletions)
                        .fixedSize()
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// The small section header of the sidebar and the home: "title · detail", muted.
struct HomeSectionHeader: View {
    let title: String
    var detail = ""

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.mutedForeground)
            if !detail.isEmpty {
                Text("· \(detail)")
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.subtleForeground)
            }
        }
        .textCase(nil)
        .lineLimit(1)
    }
}

/// The leading icon of a workspace row: the agent's avatar with its state dot, or the branch.
struct WorkspaceRowIcon: View {
    let workspace: Coflux_V1_Workspace
    let activity: WorkspaceActivity
    var size: CGFloat = 26
    @Environment(SceneNavigation.self) private var navigation

    /// Clawd's pose for the row's agent: confetti for a finished turn nobody has looked at yet.
    private var clawd: ClawdPose {
        let seen = navigation.isTurnSeen(taskID: activity.taskID, centreSeen: activity.agentSeen)
        return ClawdPose(state: activity.agentState ?? "", seen: seen)
    }

    var body: some View {
        if let agent = activity.agent {
            AgentAvatar(mark: .agent(agent), size: size, dot: activity.tone.color, clawd: clawd)
        } else {
            // 与桌面侧栏同源：lucide GitBranch（asset 模板渲染），main 分支用 warning 色
            Image("git-branch")
                .resizable()
                .scaledToFit()
                .frame(width: size * 0.66, height: size * 0.66)
                .foregroundStyle(workspace.isMain ? Theme.warning : Theme.mutedForeground)
                .frame(width: size, height: size)
        }
    }
}

/// The card surface of the redesign: raised fill, hairline border.
struct CardBackground: ViewModifier {
    var radius: CGFloat = Theme.Metrics.cardRadius

    func body(content: Content) -> some View {
        content
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border, lineWidth: 1))
    }
}

extension View {
    func cardBackground(radius: CGFloat = Theme.Metrics.cardRadius) -> some View {
        modifier(CardBackground(radius: radius))
    }
}

/// Offline / reconnecting strip shown above home and the sidebar.
struct ConnectionBanner: View {
    let client: CofluxClient

    var body: some View {
        if client.status != .connected {
            Label(
                client.status == .connecting ? "连接中…" : "连接已断开，网络恢复后会自动重连",
                systemImage: client.status == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash"
            )
            .font(Theme.Fonts.label.weight(.medium))
            .foregroundStyle(Theme.warning)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Theme.warning.opacity(0.12))
        }
    }
}
