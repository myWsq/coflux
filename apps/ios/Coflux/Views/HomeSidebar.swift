import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// Home compacted into the split layout's sidebar (plan D8, mockup W1/W2), laid out like the
/// desktop's: "待处理" rows, the projects with their workspace rows, then every device. Its top bar
/// is the account — who is signed in on the left, settings on the right — in place of a title
/// (no search, no separate account button — user's call, 2026-11-09). Tapping a row switches the detail column to that terminal — a
/// device's row to the device's own terminal page — with no back navigation; the selected row is
/// highlighted. Workspace rows end their state line with the diff. When the sidebar is wide (book pose, where it takes the leading half) the rows carry
/// more: the time and the custom label. In the tall layout the same sidebar floats over the
/// terminal (`AppShell`).
struct HomeSidebar: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @Environment(\.shellLayout) private var layout
    @State private var wide = false
    /// The sidebar's width: the account in its top bar gets what the bar's buttons leave.
    @State private var width: CGFloat = 0
    @State private var secretSheet: SecretSheetTarget?
    @State private var showingSettings = false

    private static let wideWidth: CGFloat = 380

    var body: some View {
        let items = client.waitingItems
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
                let members = client.workspaces.filter { $0.projectID == project.id }
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
            if !client.daemons.isEmpty {
                Section {
                    ForEach(sortedDaemons, id: \.daemonID) { daemon in
                        deviceRow(daemon)
                    }
                } header: {
                    sectionHeader("设备", detail: "\(client.daemons.filter(\.online).count) 台在线")
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.surface)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionBanner(client: client)
        }
        // The device rows show each device's latency: measured only while the sidebar is up.
        .measuresDevices(client: client)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            width = newWidth
            wide = newWidth >= Self.wideWidth
        }
        .navigationTitle("coflux")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .toolbar {
            // A fixed width: offered its ideal size, a leading item is squeezed to a sliver.
            // Wide, the system's sidebar toggle sits before it; floating, there is none.
            ToolbarItem(placement: .topBarLeading) {
                accountMenu
                    .frame(width: max(100, width - (layout == .tall ? 92 : 150)), alignment: .leading)
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) {
                Button("设置", systemImage: "gearshape") {
                    showingSettings = true
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SpeechSettingsSheet(client: client)
        }
        .sheet(item: $secretSheet) { target in
            SecretRequestSheet(client: client, taskID: target.taskID)
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
                // The sheet hangs off this sidebar: floating, it stays out until the sheet is
                // done, or the sheet would lose the view it is presented from.
                if layout == .tall { navigation.overlayVisibility = .all }
                secretSheet = SecretSheetTarget(taskID: item.taskID)
            } else {
                navigation.show(workspaceID: item.workspaceID, taskID: item.taskID)
            }
        } label: {
            HStack(spacing: 10) {
                AgentAvatar(mark: text.mark, size: 26, dot: Theme.warning, clawd: .raise)
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
                    // The diff closes the state line on the right (user's call, 2026-11-09),
                    // at any width: it no longer needs the wide sidebar's trailing column.
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
        .buttonStyle(.plain)
        .workspaceContextMenu(client: client, workspace: workspace)
        .listRowBackground(rowBackground(selected))
        .listRowSeparator(.hidden)
    }

    /// Online devices first, then by name.
    private var sortedDaemons: [Coflux_V1_DaemonInfo] {
        client.daemons.sorted { lhs, rhs in
            if lhs.online != rhs.online { return lhs.online }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }
    }

    /// A device as on the desktop's sidebar: the OS mark with a dot whose colour is the latency
    /// (hollow when offline), the name, and online · RTT · its terminals below. Offline devices
    /// are dimmed. Opens the device's own terminal page.
    private func deviceRow(_ daemon: Coflux_V1_DaemonInfo) -> some View {
        let rtt = daemon.online ? client.deviceTransports[daemon.daemonID]?.rttMs : nil
        let running = client.deviceRunningTerminalCount(daemon.daemonID)
        return Button {
            navigation.showDevice(daemonID: daemon.daemonID)
        } label: {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 26 * 0.32)
                    .fill(Theme.accentSurface)
                    .frame(width: 26, height: 26)
                    .overlay {
                        Image(systemName: devicePlatformSymbol(daemon.platform))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.foreground)
                    }
                    .overlay(alignment: .topTrailing) {
                        Group {
                            if daemon.online {
                                Circle().fill(deviceRTTTone(rtt))
                            } else {
                                Circle().fill(Theme.card)
                                    .overlay(Circle().strokeBorder(Theme.mutedForeground, lineWidth: 1.2))
                            }
                        }
                        .frame(width: 26 * 0.34, height: 26 * 0.34)
                        .overlay(Circle().strokeBorder(Theme.card, lineWidth: 2).padding(-2))
                        .offset(x: 26 * 0.1, y: -26 * 0.1)
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(daemon.name.isEmpty ? daemon.host : daemon.name)
                        .font(Theme.Fonts.rowTitle)
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                    deviceLine(online: daemon.online, rtt: rtt, running: running)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(daemon.online ? 1 : 0.55)
        .copyHandleContextMenu(.device, id: daemon.daemonID)
        .listRowBackground(rowBackground(navigation.selectedDeviceID == daemon.daemonID))
        .listRowSeparator(.hidden)
    }

    private func deviceLine(online: Bool, rtt: Double?, running: Int) -> Text {
        guard online else { return Text("离线") }
        var line = Text("在线")
        if let rtt {
            line = line + Text(" · ") + Text("\(Int(rtt.rounded())) ms").foregroundStyle(deviceRTTTone(rtt))
        }
        if running > 0 {
            line = line + Text(" · \(running) 个终端")
        }
        return line
    }

    /// Who is signed in (`AuthOk.login_name`), in the sidebar's top bar: a tap offers 退出登录.
    private var accountMenu: some View {
        let name = client.loginName
        return Menu {
            Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                client.logout()
            }
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(Theme.accentSurface)
                    .frame(width: 30, height: 30)
                    .overlay {
                        if let initial = name.first {
                            Text(String(initial).uppercased())
                                .font(Theme.Fonts.label.weight(.bold))
                                .foregroundStyle(Theme.foreground)
                        } else {
                            Image(systemName: "person.fill")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.mutedForeground)
                        }
                    }
                Text(name.isEmpty ? "已登录" : name)
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(name.isEmpty ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("账号 \(name)")
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
