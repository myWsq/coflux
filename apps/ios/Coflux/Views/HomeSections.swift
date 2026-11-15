import CofluxClientCore
import CofluxProtocol
import SwiftUI

// The home's 「当前」 and 「项目」 sections (plan 20261115-ios-current-section), written once for the
// two places that show them: the outer display's home, a scrolling stack, and the inner display's
// sidebar, a list. They read like the desktop sidebar's: the live agent terminals first, then the
// projects, collapsed until opened.

/// Where the sections are laid out; it decides only the row chrome.
enum HomeSurface {
    /// The sidebar's `List`: section headers, row insets and the selection highlight are the list's.
    case list
    /// The outer home's `LazyVStack`: rows pad themselves and nothing is selected.
    case stack
}

/// The projects the user expanded, remembered on the device and shared by every window. Projects
/// are collapsed unless their id is here, so a first launch and a newly imported project show
/// collapsed. The stored value is an array of project ids.
@MainActor
@Observable
final class ExpandedProjects {
    static let shared = ExpandedProjects()
    private static let key = "home.expandedProjects"

    private(set) var ids: Set<String>

    private init() {
        ids = Set(UserDefaults.standard.stringArray(forKey: Self.key) ?? [])
    }

    /// Flips one project. Ids not in `known` (removed projects) are dropped on the way, so the
    /// record never outgrows the project list.
    func toggle(_ projectID: String, known: Set<String>) {
        var next = ids.intersection(known)
        if ids.contains(projectID) {
            next.remove(projectID)
        } else {
            next.insert(projectID)
        }
        ids = next
        UserDefaults.standard.set(next.sorted(), forKey: Self.key)
    }

    /// Makes sure one project is expanded; nothing is written when it already is.
    func ensure(_ projectID: String, known: Set<String>) {
        guard !ids.contains(projectID) else { return }
        toggle(projectID, known: known)
    }
}

/// What a collapsed project says of its workspaces: how many wait for the user, else the highest
/// activity among them (the desktop's `summarizeProjectActivity`).
struct ProjectSummary {
    let text: String
    let color: Color

    init?(_ activities: [WorkspaceActivity]) {
        let attention = activities.count { $0.rank >= 3 }
        if attention > 0 {
            text = "\(attention) 待处理"
            color = Theme.warning
            return
        }
        switch activities.map(\.rank).max() {
        case 2:
            text = "正在执行"
            color = Theme.success
        case 1:
            text = "本轮完成"
            color = Theme.info
        default:
            return nil
        }
    }
}

enum HomeRowMetrics {
    /// A row's padding inside its highlight; the highlight sits 6 pt in from the sidebar's edges.
    static let rowInsets = EdgeInsets(top: 9, leading: 16, bottom: 9, trailing: 14)
    static let headerInsets = EdgeInsets(top: 16, leading: 16, bottom: 4, trailing: 14)
    /// How far a project's workspace rows sit in from the project row.
    static let workspaceIndent: CGFloat = 14

    /// The scroll target of a workspace row.
    static func workspaceRowID(_ workspaceID: String) -> String {
        "workspace:\(workspaceID)"
    }
}

/// 「当前」 and 「项目」. A current row opens through `onOpen`, because the surface owns the sheet a
/// secret request brings up; workspace rows open their terminal page directly.
struct HomeSections: View {
    let client: CofluxClient
    let surface: HomeSurface
    /// The sidebar in its wide form: rows carry more.
    var wide = false
    let onOpen: (CurrentTerminalRow) -> Void
    @Environment(SceneNavigation.self) private var navigation

    private struct ProjectEntry: Identifiable {
        let project: Coflux_V1_Project
        let workspaces: [Coflux_V1_Workspace]
        var id: String { project.id }
    }

    /// Visible projects in store order, each with its workspaces in tree order; a project with no
    /// workspace is not listed.
    private var projects: [ProjectEntry] {
        let workspaces = client.workspaces
        return client.visibleProjects.compactMap { project in
            let members = CurrentTerminals.ordered(workspaces, projectID: project.id)
            return members.isEmpty ? nil : ProjectEntry(project: project, workspaces: members)
        }
    }

    var body: some View {
        let rows = client.currentTerminals
        let projects = projects
        let expanded = ExpandedProjects.shared.ids
        if !rows.isEmpty {
            section("当前", detail: "\(rows.count)") {
                ForEach(rows) { row in
                    currentRow(row)
                }
            }
        }
        if !projects.isEmpty {
            section("项目") {
                ForEach(projects) { entry in
                    let isExpanded = expanded.contains(entry.project.id)
                    let activities = entry.workspaces.map { WorkspaceActivity($0, client: client) }
                    projectRow(entry.project, expanded: isExpanded, activities: activities)
                    if isExpanded {
                        ForEach(Array(zip(entry.workspaces, activities)), id: \.0.id) { workspace, activity in
                            workspaceRow(workspace, activity: activity)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Rows

    private func currentRow(_ row: CurrentTerminalRow) -> some View {
        let selected = navigation.tab == .home
            && navigation.workspaceID == row.workspace.id
            && navigation.selectedTaskID == row.task.id
        return self.row(selected: selected) {
            onOpen(row)
        } label: {
            CurrentTerminalRowContent(row: row, wide: wide)
        }
        .accessibilityHint(row.secret == nil ? "打开终端" : "提供输入")
    }

    private func projectRow(_ project: Coflux_V1_Project, expanded: Bool, activities: [WorkspaceActivity]) -> some View {
        let online = client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
        return row(selected: false) {
            let known = Set(client.projects.map(\.id))
            withAnimation(.snappy(duration: 0.2)) {
                ExpandedProjects.shared.toggle(project.id, known: known)
            }
        } label: {
            ProjectRowContent(
                name: project.name,
                deviceName: client.deviceName(project.daemonID),
                deviceOnline: online,
                expanded: expanded,
                // An expanded project's workspaces speak for themselves; an offline device's
                // agents report nothing current.
                summary: expanded || !online ? nil : ProjectSummary(activities)
            )
        }
        .accessibilityValue(expanded ? "已展开" : "已折叠")
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace, activity: WorkspaceActivity) -> some View {
        let selected = navigation.tab == .home && navigation.workspaceID == workspace.id
        return row(selected: selected, indent: HomeRowMetrics.workspaceIndent) {
            navigation.show(workspaceID: workspace.id, taskID: activity.taskID)
        } label: {
            WorkspaceRowContent(workspace: workspace, activity: activity, showsLabel: surface == .stack || wide)
        }
        // Long press: copy the handle (plan 20260914), delete a non-main workspace
        .workspaceContextMenu(client: client, workspace: workspace)
        .id(HomeRowMetrics.workspaceRowID(workspace.id))
    }

    // MARK: - Chrome

    /// A tappable row in the surface's chrome. In the stack the padding is part of the button, so
    /// the whole band is the tap target; in the list the insets and the highlight are the list's.
    @ViewBuilder
    private func row<Label: View>(
        selected: Bool,
        indent: CGFloat = 0,
        action: @escaping () -> Void,
        @ViewBuilder label: () -> Label
    ) -> some View {
        let insets = EdgeInsets(
            top: HomeRowMetrics.rowInsets.top,
            leading: HomeRowMetrics.rowInsets.leading + indent,
            bottom: HomeRowMetrics.rowInsets.bottom,
            trailing: HomeRowMetrics.rowInsets.trailing
        )
        switch surface {
        case .list:
            Button(action: action) {
                label()
            }
            .buttonStyle(.plain)
            .listRowBackground(
                RoundedRectangle(cornerRadius: 12)
                    .fill(selected ? Theme.accentSurface : Color.clear)
                    .padding(.horizontal, 6)
            )
            .listRowSeparator(.hidden)
            .listRowInsets(insets)
        case .stack:
            Button(action: action) {
                label()
                    .padding(insets)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func section<Content: View>(
        _ title: String,
        detail: String = "",
        @ViewBuilder content: () -> Content
    ) -> some View {
        let header = HomeSectionHeader(title: title, detail: detail)
        switch surface {
        case .list:
            Section {
                content()
            } header: {
                header.listRowInsets(HomeRowMetrics.headerInsets)
            }
        case .stack:
            header
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(HomeRowMetrics.headerInsets)
            content()
        }
    }
}

/// A live agent terminal: the agent's glyph with its state, the terminal's title, and below it
/// what the agent is doing and where the terminal lives. A row that waits with something to say
/// gives the line to the agent's words; where it lives then shows only when the row is wide.
struct CurrentTerminalRowContent: View {
    let row: CurrentTerminalRow
    var wide = false
    @Environment(SceneNavigation.self) private var navigation

    private var tone: WorkspaceActivity.Tone {
        switch row.state {
        case .secret, .approval, .question: .waiting
        case .error: .failed
        case .active: .active
        case .done: .done
        }
    }

    private var stateText: String {
        func joined(_ head: String, _ tail: String) -> String {
            tail.isEmpty ? head : "\(head) · \(tail)"
        }
        // What the agent reports about its progress is long: only a wide row has room for it.
        let progress = wide ? row.progress : ""
        return switch row.state {
        case .secret: "等待输入 \(row.secret?.name ?? "")"
        case .approval: joined("等待批准", row.message)
        case .question: joined("等待回答", row.message)
        case .error: joined("出错了", row.message)
        case .active: joined("正在执行", progress)
        case .done: joined("本轮完成", progress)
        }
    }

    private var showsLocation: Bool {
        wide || !(row.needsAttention && !row.message.isEmpty)
    }

    /// Clawd waves for a secret request too; a finished turn somebody looked at stands still.
    private var clawd: ClawdPose {
        if row.state == .secret { return .raise }
        let seen = navigation.isTurnSeen(taskID: row.task.id, centreSeen: row.seen)
        return ClawdPose(state: row.agentState, seen: seen)
    }

    var body: some View {
        HStack(spacing: 10) {
            AgentAvatar(mark: .agent(row.agent), size: 26, dot: tone.color, clawd: clawd)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                HStack(spacing: 0) {
                    Text(stateText)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(tone.color)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if showsLocation {
                        Text(" · \(row.location)")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.subtleForeground)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

/// A project: a chevron that turns when its workspaces are listed, the name and its device; when
/// collapsed, what its workspaces are up to. An offline device shows a hollow dot instead.
struct ProjectRowContent: View {
    let name: String
    let deviceName: String
    let deviceOnline: Bool
    let expanded: Bool
    let summary: ProjectSummary?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.mutedForeground)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                // The workspace rows' icon slot, so names line up.
                .frame(width: 26, height: 26)
            HStack(spacing: 4) {
                Text(name)
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(Theme.foreground)
                    .layoutPriority(1)
                if !deviceName.isEmpty {
                    Text("· \(deviceName)")
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.subtleForeground)
                }
            }
            .lineLimit(1)
            Spacer(minLength: 6)
            if !deviceOnline {
                Circle()
                    .strokeBorder(Theme.mutedForeground, lineWidth: 1.2)
                    .frame(width: 6, height: 6)
                    .accessibilityLabel("设备离线")
            } else if let summary {
                Text(summary.text)
                    .font(Theme.Fonts.meta.weight(.medium))
                    .foregroundStyle(summary.color)
                    .fixedSize()
            }
        }
        .contentShape(Rectangle())
    }
}

extension View {
    /// Answers a jump (`SceneNavigation.show`) on the home or the sidebar: the shown workspace's
    /// project expands and its row scrolls into view.
    func revealsShownWorkspace(client: CofluxClient, proxy: ScrollViewProxy) -> some View {
        modifier(RevealShownWorkspace(client: client, proxy: proxy))
    }
}

/// The key is (jump counter, the shown workspace's project): the counter covers showing the
/// workspace that is already selected, the project covers a selection that arrives before the
/// snapshot does. It does not follow the expanded set, so a project collapsed by hand stays
/// collapsed until the next jump.
private struct RevealShownWorkspace: ViewModifier {
    let client: CofluxClient
    let proxy: ScrollViewProxy
    @Environment(SceneNavigation.self) private var navigation

    private var key: SceneNavigation.RevealKey {
        let workspace = navigation.workspaceID.flatMap { id in client.workspaces.first { $0.id == id } }
        // A directory workspace has no project row: nothing to expand or scroll to.
        let projectID = workspace.flatMap { workspace in
            client.visibleProjects.contains { $0.id == workspace.projectID } ? workspace.projectID : nil
        }
        return SceneNavigation.RevealKey(nonce: navigation.revealNonce, projectID: projectID ?? "")
    }

    func body(content: Content) -> some View {
        content.onChange(of: key, initial: true) { _, key in
            guard navigation.handledReveal != key else { return }
            navigation.handledReveal = key
            guard !key.projectID.isEmpty, let workspaceID = navigation.workspaceID else { return }
            ExpandedProjects.shared.ensure(key.projectID, known: Set(client.projects.map(\.id)))
            // The row exists only once the expansion has rendered.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(80))
                withAnimation(.snappy(duration: 0.2)) {
                    proxy.scrollTo(HomeRowMetrics.workspaceRowID(workspaceID))
                }
            }
        }
    }
}
