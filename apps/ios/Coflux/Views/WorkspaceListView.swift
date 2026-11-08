import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 首页（compact and tall layouts, plan D4/D6/D7): what waits for the user first, then the
/// projects. "需要你" is a horizontally paged row of cards — one per waiting item — and is hidden
/// when nothing waits; "项目" keeps the desktop sidebar's hierarchy (project → workspaces) with the
/// agent state on each row. 断线不清空内容：保留最后快照渲染，顶部横幅提示。
/// The page lives in the 首页 tab's NavigationStack; its chrome is the system large title and
/// toolbar. Opening a card or a row goes through `SceneNavigation.show`.
struct WorkspaceListView: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @State private var waitingPage: String?
    @State private var showingNewTerminal = false
    @State private var secretSheet: SecretSheetTarget?

    var body: some View {
        let items = client.waitingItems
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !items.isEmpty {
                    waitingSection(items)
                }
                if !client.visibleProjects.isEmpty {
                    projectsSection
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .background(Theme.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionBanner(client: client)
        }
        .overlay {
            if client.visibleProjects.isEmpty, items.isEmpty {
                ContentUnavailableView(
                    "暂无项目",
                    systemImage: "tray",
                    description: Text("在桌面端导入 Git 仓库后会显示在这里")
                )
            }
        }
        .navigationTitle("coflux")
        .navigationSubtitle(onlineDevicesSubtitle(client))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                AccountMenu(client: client)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewTerminal = true
                } label: {
                    Label("新建终端", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showingNewTerminal) {
            NewTerminalPicker(client: client)
        }
        .sheet(item: $secretSheet) { target in
            SecretRequestSheet(client: client, taskID: target.taskID)
        }
    }

    // MARK: - 需要你

    private func waitingSection(_ items: [WaitingItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("待处理")
                    .font(Theme.Fonts.sectionTitle)
                Text("\(items.count)")
                    .font(Theme.Fonts.meta.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Theme.warning)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Theme.warning.opacity(0.16), in: Capsule())
            }
            .padding(.horizontal, 20)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(items) { item in
                        waitingCard(item)
                            .containerRelativeFrame(.horizontal)
                            .id(item.id)
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $waitingPage)
            .scrollIndicators(.hidden)
            if items.count > 1 {
                pageDots(items)
            }
        }
    }

    private func waitingCard(_ item: WaitingItem) -> some View {
        let text = WaitingItemText(item, client: client)
        let subtitle = [text.context, relativeTimeLabel(item.time)]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        // The whole card is the tap target: it opens the terminal, or the input sheet for a
        // secret request.
        return Button {
            open(item)
        } label: {
            waitingCardBody(text, subtitle: subtitle)
        }
        .buttonStyle(.plain)
        .accessibilityHint(text.isSecret ? "提供输入" : "打开终端")
    }

    private func waitingCardBody(_ text: WaitingItemText, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                AgentAvatar(mark: text.mark)
                VStack(alignment: .leading, spacing: 1) {
                    Text(text.title)
                        .font(Theme.Fonts.rowTitle)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(text.pill)
                    .font(Theme.Fonts.meta.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Theme.warning.opacity(0.14), in: Capsule())
            }
            Text(text.message)
                .font(Theme.Fonts.cardBody)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardBackground(radius: 26)
        .contentShape(.rect(cornerRadius: 26))
    }

    private func pageDots(_ items: [WaitingItem]) -> some View {
        let current = waitingPage ?? items.first?.id
        return HStack(spacing: 5) {
            ForEach(items) { item in
                Capsule()
                    .fill(item.id == current ? Theme.foreground : Theme.subtleForeground)
                    .frame(width: item.id == current ? 16 : 6, height: 6)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.smooth(duration: 0.2), value: current)
        .accessibilityHidden(true)
    }

    private func open(_ item: WaitingItem) {
        if case .secret = item.kind {
            secretSheet = SecretSheetTarget(taskID: item.taskID)
        } else {
            navigation.show(workspaceID: item.workspaceID, taskID: item.taskID)
        }
    }

    // MARK: - 项目

    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("项目")
                .font(Theme.Fonts.sectionTitle)
                .padding(.horizontal, 20)
                .padding(.top, 6)
            ForEach(client.visibleProjects, id: \.id) { project in
                projectCard(project)
            }
            .padding(.horizontal, 16)
        }
    }

    private func projectCard(_ project: Coflux_V1_Project) -> some View {
        let members = client.workspaces.filter { $0.projectID == project.id }
        let online = client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image("folder")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 15, height: 15)
                    .foregroundStyle(Theme.mutedForeground)
                Text(project.name)
                    .font(Theme.Fonts.rowTitle)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Circle()
                    .fill(online ? Theme.success : Theme.subtleForeground)
                    .frame(width: 7, height: 7)
                Text(client.deviceName(project.daemonID))
                    .font(Theme.Fonts.label)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            ForEach(members, id: \.id) { workspace in
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 1)
                workspaceRow(workspace)
            }
        }
        .padding(.vertical, 2)
        .cardBackground()
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let activity = WorkspaceActivity(workspace, client: client)
        return Button {
            navigation.show(workspaceID: workspace.id, taskID: activity.taskID)
        } label: {
            HStack(spacing: 12) {
                WorkspaceRowIcon(workspace: workspace, activity: activity)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(workspace.displayTitle)
                            .font(Theme.Fonts.rowTitle)
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                        if let label = workspace.customLabel {
                            Text(label)
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(Theme.subtleForeground)
                                .lineLimit(1)
                        }
                    }
                    Text(activity.subtitle)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(activity.tone.color)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                DiffStat(additions: workspace.additions, deletions: workspace.deletions)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // 长按复制工作区标识（plan 20260914）
        .copyHandleContextMenu(.workspace, id: workspace.id)
    }
}

/// Which terminal's secret requests the sheet shows.
struct SecretSheetTarget: Identifiable, Hashable {
    let taskID: String
    var id: String { taskID }
}

/// 新建终端 from home: a picker of workspaces grouped by project. Choosing one creates a terminal
/// there ("终端 N", as the terminal page names them); the window's shell opens and starts it as
/// soon as it appears in the snapshot (`SceneNavigation.pendingTerminal`).
struct NewTerminalPicker: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(client.visibleProjects, id: \.id) { project in
                    let members = client.workspaces.filter { $0.projectID == project.id }
                    if !members.isEmpty {
                        Section(project.name) {
                            ForEach(members, id: \.id) { workspace in
                                Button {
                                    create(in: workspace)
                                } label: {
                                    HStack(spacing: 8) {
                                        Text(workspace.displayTitle)
                                            .font(Theme.Fonts.body)
                                            .foregroundStyle(Theme.foreground)
                                            .lineLimit(1)
                                        if let label = workspace.customLabel {
                                            Text(label)
                                                .font(Theme.Fonts.label)
                                                .foregroundStyle(Theme.mutedForeground)
                                                .lineLimit(1)
                                        }
                                    }
                                }
                                .listRowBackground(Theme.card)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("新建终端")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func create(in workspace: Coflux_V1_Workspace) {
        let known = Set(client.tasks.filter { $0.workspaceID == workspace.id }.map(\.id))
        navigation.pendingTerminal = SceneNavigation.PendingTerminal(workspaceID: workspace.id, knownTaskIDs: known)
        client.createTask(workspaceID: workspace.id, title: "终端 \(known.count + 1)")
        dismiss()
    }
}
