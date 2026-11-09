import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 首页 of the compact layout (the outer display; plan D4/D6/D7, mockup B of
/// `wiki/plans/20261110-ios-outer-home-rows-mockup.html`): what waits for the user first, then the
/// projects. "待处理" is a horizontally paged row of cards — one per waiting item — and is hidden
/// when nothing waits. The projects read exactly like the inner display's sidebar: a small header
/// "project · device" per project and its workspace rows (`WorkspaceRowContent`), no cards and no
/// page title — the outer display is short, so content starts at the top. 断线不清空内容：保留最后
/// 快照渲染，顶部横幅提示。Opening a card or a row goes through `SceneNavigation.show`.
struct WorkspaceListView: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @State private var waitingPage: String?
    @State private var showingNewTerminal = false
    @State private var secretSheet: SecretSheetTarget?
    @State private var showingSettings = false

    var body: some View {
        let items = client.waitingItems
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !items.isEmpty {
                    waitingSection(items)
                }
                projectsSection
            }
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
        // Named for the back button and VoiceOver; not drawn.
        .navigationTitle("coflux")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("设置", systemImage: "gearshape") {
                    showingSettings = true
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewTerminal = true
                } label: {
                    Label("新建终端", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsSheet(client: client)
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
        VStack(alignment: .leading, spacing: 8) {
            HomeSectionHeader(title: "待处理", detail: "\(items.count)")
                .padding(.horizontal, Self.sideInset)
                .padding(.top, Self.headerTop)
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
        // A horizontal scroll view reaches into the safe area along its axis: on the outer
        // display the next card showed through the system rail. Clip to the content column.
        .clipped()
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
                AgentAvatar(mark: text.mark, clawd: .raise)
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

    /// The sidebar's metrics (`HomeSidebar.rowInsets` / `headerInsets`).
    private static let sideInset: CGFloat = 16
    private static let headerTop: CGFloat = 16

    private var projectsSection: some View {
        ForEach(client.visibleProjects, id: \.id) { project in
            let members = client.workspaces.filter { $0.projectID == project.id }
            HomeSectionHeader(
                title: project.name,
                detail: client.deviceName(project.daemonID),
                deviceOnline: client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
            )
            .padding(.horizontal, Self.sideInset)
            .padding(.top, Self.headerTop)
            .padding(.bottom, 4)
            ForEach(members, id: \.id) { workspace in
                workspaceRow(workspace)
            }
        }
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let activity = WorkspaceActivity(workspace, client: client)
        return Button {
            navigation.show(workspaceID: workspace.id, taskID: activity.taskID)
        } label: {
            WorkspaceRowContent(workspace: workspace, activity: activity)
                .padding(.leading, Self.sideInset)
                .padding(.trailing, 14)
                .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
        // Long press: copy the handle (plan 20260914), delete a non-main workspace
        .workspaceContextMenu(client: client, workspace: workspace)
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
