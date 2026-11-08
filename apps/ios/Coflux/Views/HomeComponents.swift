import CofluxClientCore
import CofluxProtocol
import SwiftUI

// Building blocks shared by the compact home (WorkspaceListView) and the split sidebar
// (HomeSidebar): avatars, the waiting-item wording and the workspace activity line.

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

/// The wording of one waiting item, resolved against the live client state.
struct WaitingItemText {
    let mark: AgentAvatar.Mark
    /// Agent name, or the secret's name
    let title: String
    /// project · branch
    let context: String
    /// 在问你 / 要权限 / 等输入
    let pill: String
    /// The agent's message, or a generic line when it left none
    let message: String
    let isSecret: Bool

    @MainActor
    init(_ item: WaitingItem, client: CofluxClient) {
        let workspace = client.workspaces.first { $0.id == item.workspaceID }
        let project = client.projects.first { $0.id == item.projectID }
        let branch = workspace.map { $0.branch.isEmpty ? $0.name : $0.branch } ?? ""
        context = [project?.name ?? client.deviceName(item.daemonID), branch]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        switch item.kind {
        case .agent(let name, let state, let message):
            mark = .agent(name)
            title = name.isEmpty ? "agent" : name
            pill = state == .question ? "等待回答" : "等待批准"
            self.message = message.isEmpty ? (state == .question ? "有问题需要你回答" : "有操作需要你批准") : message
            isSecret = false
        case .secret(let request):
            mark = .secret
            title = request.name
            pill = "等待输入"
            message = request.reason.isEmpty ? "Agent 请求输入 \(request.name)" : request.reason
            isSecret = true
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

        var color: Color {
            switch self {
            case .waiting: Theme.warning
            case .active: Theme.success
            case .done: Theme.info
            case .idle: Theme.mutedForeground
            }
        }
    }

    /// The agent shown on the row (nil: no agent, the row shows the branch icon).
    let agent: String?
    /// That agent's turn state (`SessionAgentRef.state`); a pending secret request counts as
    /// waiting for approval.
    let agentState: String?
    let tone: Tone
    let subtitle: String
    /// The terminal the row opens: the one that waits, else the agent's, else nil (keep the last).
    let taskID: String?

    @MainActor
    init(_ workspace: Coflux_V1_Workspace, client: CofluxClient) {
        let tasks = client.tasks.filter { $0.workspaceID == workspace.id }
        let running = tasks.filter { $0.status == .running }
        let progress = client.workspaceProgress(workspaceID: workspace.id)
        var best: (task: Coflux_V1_Task, ref: Coflux_V1_SessionAgentRef, rank: Int)?
        for task in running {
            guard let ref = client.agent(forTask: task) else { continue }
            let rank = switch ref.state {
            case "approval": 4
            case "question": 3
            case "active": 2
            case "done": 1
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
            tone = .waiting
            subtitle = "等待输入 \(secret.name)"
            taskID = secret.taskID
        } else if let best, best.rank >= 1 {
            agent = best.ref.agent
            agentState = best.ref.state
            taskID = best.task.id
            let message = best.ref.message.isEmpty ? nil : best.ref.message
            switch best.rank {
            case 4:
                tone = .waiting
                subtitle = joined("等待批准", message)
            case 3:
                tone = .waiting
                subtitle = joined("等待回答", message)
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
            taskID = best?.task.id
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

/// The leading icon of a workspace row: the agent's avatar with its state dot, or the branch.
struct WorkspaceRowIcon: View {
    let workspace: Coflux_V1_Workspace
    let activity: WorkspaceActivity
    var size: CGFloat = 26
    @Environment(SceneNavigation.self) private var navigation

    /// Clawd's pose for the row's agent: confetti for a finished turn nobody has looked at yet.
    private var clawd: ClawdPose {
        let seen = activity.taskID.map { navigation.seenFinishedTaskIDs.contains($0) } ?? false
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

/// A short relative time for a millisecond epoch (刚刚 / 2 分钟前).
func relativeTimeLabel(_ milliseconds: Double, now: Date = .now) -> String {
    guard milliseconds > 0 else { return "" }
    let date = Date(timeIntervalSince1970: milliseconds / 1000)
    if now.timeIntervalSince(date) < 60 { return "刚刚" }
    return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
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

/// "N 台设备在线" for the home title's subtitle.
@MainActor
func onlineDevicesSubtitle(_ client: CofluxClient) -> String {
    let online = client.daemons.filter(\.online).count
    return online == 0 ? "没有在线设备" : "\(online) 台设备在线"
}

/// The account menu of home and the sidebar.
struct AccountMenu: View {
    let client: CofluxClient

    var body: some View {
        Menu {
            Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                client.logout()
            }
        } label: {
            Label("账号", systemImage: "person.crop.circle")
        }
    }
}
