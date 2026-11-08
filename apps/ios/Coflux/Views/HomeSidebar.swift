import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// Home compacted into the split layout's sidebar (plan D8, mockup W1/W2): "需要你" rows, then the
/// projects with their workspace rows, and the 设备 entry. Tapping a row switches the detail column
/// to that terminal with no back navigation; the selected row is highlighted. The search field at
/// the bottom filters workspaces and terminals by name. When the sidebar is wide (book pose, where
/// it takes the leading half) the rows carry more: the time and the diff.
struct HomeSidebar: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @State private var query = ""
    @State private var wide = false
    @State private var secretSheet: SecretSheetTarget?

    private static let wideWidth: CGFloat = 380

    var body: some View {
        let items = filteredItems
        List {
            if !items.isEmpty {
                Section {
                    ForEach(items) { item in
                        waitingRow(item)
                    }
                } header: {
                    sectionHeader("待处理", detail: "\(items.count)")
                }
            }
            ForEach(client.visibleProjects, id: \.id) { project in
                let members = filteredWorkspaces(in: project)
                if !members.isEmpty {
                    Section {
                        ForEach(members, id: \.id) { workspace in
                            workspaceRow(workspace)
                        }
                    } header: {
                        sectionHeader(project.name, detail: client.deviceName(project.daemonID))
                    }
                }
            }
            Section {
                devicesRow
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.surface)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionBanner(client: client)
        }
        .onGeometryChange(for: Bool.self) { proxy in
            proxy.size.width >= Self.wideWidth
        } action: { isWide in
            wide = isWide
        }
        .searchable(text: $query, prompt: "搜索终端")
        .navigationTitle("coflux")
        .navigationSubtitle(onlineDevicesSubtitle(client))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                AccountMenu(client: client)
            }
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
        }
        .sheet(item: $secretSheet) { target in
            SecretRequestSheet(client: client, taskID: target.taskID)
        }
    }

    // MARK: - Filtering

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func matches(_ text: String) -> Bool {
        text.localizedCaseInsensitiveContains(trimmedQuery)
    }

    private func workspaceMatches(_ workspace: Coflux_V1_Workspace) -> Bool {
        guard !trimmedQuery.isEmpty else { return true }
        if matches(workspace.name) || matches(workspace.branch) { return true }
        return client.tasks.contains { $0.workspaceID == workspace.id && matches($0.title) }
    }

    private func filteredWorkspaces(in project: Coflux_V1_Project) -> [Coflux_V1_Workspace] {
        client.workspaces.filter { $0.projectID == project.id && workspaceMatches($0) }
    }

    private var filteredItems: [WaitingItem] {
        let items = client.waitingItems
        guard !trimmedQuery.isEmpty else { return items }
        return items.filter { item in
            let text = WaitingItemText(item, client: client)
            if matches(text.title) || matches(text.context) { return true }
            return client.tasks.contains { $0.id == item.taskID && matches($0.title) }
        }
    }

    // MARK: - Rows

    private func sectionHeader(_ title: String, detail: String) -> some View {
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

    private func waitingRow(_ item: WaitingItem) -> some View {
        let text = WaitingItemText(item, client: client)
        let selected = navigation.tab == .home
            && navigation.workspaceID == item.workspaceID
            && navigation.selectedTaskID == item.taskID
        // One line: the state plus the message when wide, the project otherwise.
        let line = wide ? "\(text.pill)：\(text.message)" : "\(text.pill) · \(text.context)"
        return Button {
            if case .secret = item.kind {
                if !item.workspaceID.isEmpty {
                    navigation.show(workspaceID: item.workspaceID, taskID: item.taskID)
                }
                secretSheet = SecretSheetTarget(taskID: item.taskID)
            } else {
                navigation.show(workspaceID: item.workspaceID, taskID: item.taskID)
            }
        } label: {
            HStack(spacing: 10) {
                AgentAvatar(mark: text.mark, size: 26, dot: Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text.isSecret ? text.title : (workspaceTitle(item.workspaceID) ?? text.title))
                        .font(Theme.Fonts.rowTitle)
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    Text(line)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.warning)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                if wide {
                    Text(relativeTimeLabel(item.time))
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.subtleForeground)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(rowBackground(selected))
        .listRowSeparator(.hidden)
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let activity = WorkspaceActivity(workspace, client: client)
        let selected = navigation.tab == .home && navigation.workspaceID == workspace.id
        return Button {
            navigation.show(workspaceID: workspace.id, taskID: activity.taskID)
        } label: {
            HStack(spacing: 10) {
                WorkspaceRowIcon(workspace: workspace, activity: activity)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(workspace.displayTitle)
                            .font(Theme.Fonts.rowTitle)
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                        if wide, let label = workspace.customLabel {
                            Text(label)
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(Theme.subtleForeground)
                                .lineLimit(1)
                        }
                    }
                    Text(activity.subtitle)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(activity.tone.color)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                if wide {
                    DiffStat(additions: workspace.additions, deletions: workspace.deletions)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .workspaceContextMenu(client: client, workspace: workspace)
        .listRowBackground(rowBackground(selected))
        .listRowSeparator(.hidden)
    }

    private var devicesRow: some View {
        Button {
            navigation.tab = .devices
        } label: {
            Label("设备", systemImage: "macbook.and.iphone")
                .font(Theme.Fonts.rowTitle)
                .foregroundStyle(Theme.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(rowBackground(navigation.tab == .devices))
        .listRowSeparator(.hidden)
    }

    private func rowBackground(_ selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(selected ? Theme.accentSurface : Color.clear)
            .padding(.horizontal, 8)
    }

    private func workspaceTitle(_ workspaceID: String) -> String? {
        client.workspaces.first { $0.id == workspaceID }?.displayTitle
    }
}
