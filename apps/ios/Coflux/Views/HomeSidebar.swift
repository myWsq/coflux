import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// Home compacted into the split layout's sidebar (plan D8, mockup W1/W2), laid out like the
/// desktop's: 「当前」 — the live agent terminals — then the projects, collapsed until opened, each
/// with its workspace rows (`HomeSections`), then every device. Its top bar
/// is the account — who is signed in on the left, settings on the right — in place of a title
/// (no search, no separate account button — user's call, 2026-11-09). Tapping a row switches the detail column to that terminal — a
/// device's row to the device's own terminal page — with no back navigation; the selected row is
/// highlighted. Workspace rows end their state line with the diff. When the sidebar is wide (book pose, where it takes the leading half) the rows carry
/// more: the agent's progress and the custom label. In the tall layout the same sidebar floats over the
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
        ScrollViewReader { proxy in
            list.revealsShownWorkspace(client: client, proxy: proxy)
        }
    }

    private var list: some View {
        List {
            HomeSections(client: client, surface: .list, wide: wide, onOpen: open)
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
        // Denser than the system's rows (user's call, 2026-11-10; 6 pt insets were too tight):
        // rows as tall as their two lines plus `HomeRowMetrics.rowInsets`, not the 44 pt minimum.
        .environment(\.defaultMinListRowHeight, 1)
        .listSectionSpacing(0)
        .contentMargins(.top, 2, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(Theme.surface)
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
            // A fixed width: offered its ideal size, a leading item is squeezed to a sliver; too
            // wide, the bar folds both items into its overflow button (seen on the Duo,
            // 2026-11-10, at width − 92). Measured there: ~20 pt bar margins on each side and a
            // 48 pt settings button, so the account gets the width less 120. Wide, the system's
            // sidebar toggle (48 pt and a gap) sits before it as well.
            ToolbarItem(placement: .topBarLeading) {
                accountMenu
                    .frame(width: max(100, width - (layout == .tall ? 120 : 180)), alignment: .leading)
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) {
                Button("设置", systemImage: "gearshape") {
                    showingSettings = true
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsSheet(client: client)
        }
        .sheet(item: $secretSheet) { target in
            SecretRequestSheet(client: client, taskID: target.taskID)
        }
    }

    // MARK: - Rows

    private func sectionHeader(_ title: String, detail: String) -> some View {
        HomeSectionHeader(title: title, detail: detail)
            .listRowInsets(HomeRowMetrics.headerInsets)
    }

    /// A 「当前」 row: its terminal, and the input sheet when a secret request waits in it.
    private func open(_ row: CurrentTerminalRow) {
        navigation.show(workspaceID: row.workspace.id, taskID: row.task.id)
        guard row.secret != nil else { return }
        // The sheet hangs off this sidebar: floating, it stays out until the sheet is done, or
        // the sheet would lose the view it is presented from.
        if layout == .tall { navigation.overlayVisibility = .all }
        secretSheet = SecretSheetTarget(taskID: row.task.id)
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
        Button {
            navigation.showDevice(daemonID: daemon.daemonID)
        } label: {
            DeviceRowContent(client: client, daemon: daemon)
        }
        .buttonStyle(.plain)
        .copyHandleContextMenu(.device, id: daemon.daemonID)
        .listRowBackground(rowBackground(navigation.selectedDeviceID == daemon.daemonID))
        .listRowSeparator(.hidden)
        .listRowInsets(HomeRowMetrics.rowInsets)
    }

    /// Who is signed in (`AuthOk.login_name`) and the connection to the centre, in the sidebar's
    /// top bar: two lines in the terminal page's title style, no avatar (user's calls,
    /// 2026-11-10), centred on the settings button beside it. The second line replaces the
    /// home's disconnection banner here, so the list never jumps when it comes and goes. A tap
    /// offers 退出登录.
    private var accountMenu: some View {
        let name = client.loginName
        return Menu {
            Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                client.logout()
            }
        } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(name.isEmpty ? "已登录" : name)
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(name.isEmpty ? Theme.mutedForeground : Theme.foreground)
                    .truncationMode(.middle)
                connectionLine
                    .font(Theme.Fonts.meta)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("账号 \(name)")
    }

    @ViewBuilder
    private var connectionLine: some View {
        switch client.status {
        case .connected:
            Text("已连接").foregroundStyle(Theme.mutedForeground)
        case .connecting:
            Text("连接中…").foregroundStyle(Theme.warning)
        case .disconnected:
            Text("已断开，恢复后自动重连").foregroundStyle(Theme.warning)
        }
    }

    private func rowBackground(_ selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(selected ? Theme.accentSurface : Color.clear)
            .padding(.horizontal, 6)
    }
}
