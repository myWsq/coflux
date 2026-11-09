import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// The signed-in shell of one window. It measures its own window and picks a layout
/// (`ShellLayout`): compact is a `TabView` (首页 / 设备) with one `NavigationStack` per tab; split
/// and tall are a `NavigationSplitView` with the compact home as sidebar and the selected
/// terminal as detail — side by side when wide, floating over the terminal when tall (mockup
/// `wiki/plans/20261109-ios-inner-tall-sidebar-mockup.html`). Rotating, opening or closing the Duo, entering Split View or resizing a
/// window re-runs the choice; the selection lives in `SceneNavigation`, so it survives.
/// All chrome is system containers and toolbars — nothing is drawn by hand (D3).
struct AppShell: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation

    var body: some View {
        GeometryReader { proxy in
            // The window: the container plus the safe-area insets the system takes from it.
            let window = CGSize(
                width: proxy.size.width + proxy.safeAreaInsets.leading + proxy.safeAreaInsets.trailing,
                height: proxy.size.height + proxy.safeAreaInsets.top + proxy.safeAreaInsets.bottom
            )
            let layout = ShellLayout.choose(for: window)
            Group {
                switch layout {
                case .compact:
                    tabLayout
                case .split:
                    splitLayout(fold: Self.bookFold(in: proxy))
                case .tall:
                    overlayLayout
                }
            }
            .environment(\.shellLayout, layout)
            // Nothing to show yet in a tall window: the floating sidebar comes out by itself.
            .onChange(of: layout, initial: true) { _, layout in
                if layout == .tall, navigation.tab == .home, navigation.workspaceID == nil {
                    navigation.overlayVisibility = .all
                }
            }
        }
        .background(Theme.background)
        .overlay(alignment: .top) {
            ErrorToast(client: client)
        }
        // A finished terminal the user looked at is forgotten once its agent is no longer
        // finished, so its next finished turn throws confetti again.
        .onChange(of: finishedTaskIDs) { _, finished in
            let seen = navigation.seenFinishedTaskIDs.intersection(finished)
            if seen != navigation.seenFinishedTaskIDs { navigation.seenFinishedTaskIDs = seen }
        }
        // A terminal created from home opens (and starts) as soon as it appears.
        .onChange(of: client.tasks.map(\.id)) { _, _ in
            openPendingTerminal()
        }
    }

    /// Terminals whose agent has finished its turn.
    private var finishedTaskIDs: Set<String> {
        Set(client.sessionAgents.values.compactMap { info in
            let state = info.session.state
            return state == "done" || state == "waiting" ? info.session.taskID : nil
        })
    }

    private func openPendingTerminal() {
        guard let pending = navigation.pendingTerminal,
              let task = client.tasks
                  .filter({ $0.workspaceID == pending.workspaceID && !pending.knownTaskIDs.contains($0.id) })
                  .min(by: { $0.createdAt < $1.createdAt })
        else { return }
        navigation.pendingTerminal = nil
        // A created task is IDLE: start it, as the terminal page does for the terminals it creates.
        client.startTask(taskID: task.id, cols: 80, rows: 24)
        navigation.show(workspaceID: pending.workspaceID, taskID: task.id)
    }

    // MARK: - Tab layout (compact and tall)

    private var tabLayout: some View {
        @Bindable var navigation = navigation
        return TabView(selection: $navigation.tab) {
            Tab("首页", systemImage: "house", value: SceneNavigation.Tab.home) {
                NavigationStack(path: $navigation.homePath) {
                    WorkspaceListView(client: client)
                        .navigationDestination(for: HomeRoute.self) { route in
                            WorkspacePage(client: client, workspaceID: route.workspaceID)
                        }
                }
            }
            .badge(waitingCount)
            Tab("设备", systemImage: "macbook.and.iphone", value: SceneNavigation.Tab.devices) {
                NavigationStack(path: $navigation.devicePath) {
                    DevicesView(client: client)
                }
            }
        }
    }

    // MARK: - Split layout (large window wider than tall)

    /// Default sidebar width with the display fully open (mockup W1); the fold is not reserved
    /// then and content may cross it.
    private static let sidebarWidth: CGFloat = 300

    /// The fold of the half-open book pose: an active dividing region that runs vertically.
    /// Fully open, the fold is not a reserved region and this is nil (D8).
    static func bookFold(in proxy: GeometryProxy) -> CGRect? {
        proxy.reservedRegions(kind: .division)
            .first { $0.isActive && $0.frame.height > $0.frame.width }?
            .frame
    }

    /// In the book pose the sidebar takes the leading half exactly up to the fold and the detail
    /// starts after it, so nothing interactive sits in the fold (mockup W2). The sidebar toggle
    /// (system) collapses the sidebar so the terminal takes the whole display.
    private func splitLayout(fold: CGRect?) -> some View {
        @Bindable var navigation = navigation
        let sidebarWidth = fold.map { max(0, $0.minX) } ?? Self.sidebarWidth
        let sidebarVisible = navigation.columnVisibility != .detailOnly
        return NavigationSplitView(columnVisibility: $navigation.columnVisibility) {
            HomeSidebar(client: client)
                .navigationSplitViewColumnWidth(
                    min: fold == nil ? Self.sidebarMinWidth : sidebarWidth,
                    ideal: sidebarWidth,
                    max: fold == nil ? Self.sidebarMaxWidth : sidebarWidth
                )
        } detail: {
            detailColumn
                .padding(.leading, sidebarVisible ? (fold?.width ?? 0) : 0)
        }
    }

    /// The range the sidebar can be dragged across, wide or floating.
    private static let sidebarMinWidth: CGFloat = 260
    private static let sidebarMaxWidth: CGFloat = 360
    /// The floating sidebar's default width (user's call, 2026-11-09).
    private static let overlaySidebarWidth: CGFloat = 320

    // MARK: - Overlay layout (large window taller than wide)

    /// The tall layout: the same split view with the detail prominent — the terminal fills the
    /// window and the sidebar floats over it, so bringing it out never resizes the terminal. A
    /// selection puts it away (`SceneNavigation.show`), and so do a swipe back over it and a tap
    /// on the dimmed terminal — the floating sidebar has no button of its own (user's call,
    /// 2026-11-09). The system's sidebar toggle is replaced by `SidebarToggleButton`, which
    /// carries the waiting count the 首页 tab used to.
    private var overlayLayout: some View {
        @Bindable var navigation = navigation
        return NavigationSplitView(columnVisibility: $navigation.overlayVisibility) {
            HomeSidebar(client: client)
                .navigationSplitViewColumnWidth(
                    min: Self.sidebarMinWidth,
                    ideal: Self.overlaySidebarWidth,
                    max: Self.sidebarMaxWidth
                )
        } detail: {
            detailColumn
        }
        .navigationSplitViewStyle(.prominentDetail)
        .toolbar(removing: .sidebarToggle)
    }

    @ViewBuilder
    private var detailColumn: some View {
        @Bindable var navigation = navigation
        if navigation.tab == .devices {
            if let daemonID = navigation.devicePath.last?.daemonID {
                // A device row of the sidebar: the device's own terminal page, like a workspace.
                NavigationStack {
                    DeviceSessionsView(client: client, daemonID: daemonID)
                        .id(daemonID)
                }
            } else {
                // Carried over from the compact layout's 设备 tab, with no device chosen yet.
                NavigationStack(path: $navigation.devicePath) {
                    DevicesView(client: client)
                        .sidebarToggleItem(client: client)
                }
            }
        } else {
            NavigationStack {
                if let workspaceID = navigation.workspaceID {
                    // The terminal page places the toggle itself, ahead of its title.
                    WorkspacePage(client: client, workspaceID: workspaceID)
                        .id(workspaceID)
                } else {
                    ContentUnavailableView(
                        "选择一个终端",
                        systemImage: "terminal",
                        description: Text("从左侧选择工作区或待处理的终端")
                    )
                    .background(Theme.background)
                    .sidebarToggleItem(client: client)
                }
            }
        }
    }

    private var waitingCount: Int {
        client.waitingCount
    }
}

/// A workspace's terminal page addressed by id: the workspace is resolved on every render, so a
/// workspace deleted elsewhere turns into an empty state instead of a stale page.
struct WorkspacePage: View {
    let client: CofluxClient
    let workspaceID: String

    var body: some View {
        if let workspace = client.workspaces.first(where: { $0.id == workspaceID }) {
            WorkspaceDetailView(client: client, workspace: workspace)
        } else {
            ContentUnavailableView(
                "工作区不可用",
                systemImage: "exclamationmark.triangle",
                description: Text("这个工作区已被删除或不在当前账号中")
            )
            .background(Theme.background)
            .sidebarToggleItem(client: client)
        }
    }
}

/// The tall layout's sidebar button, at the leading end of the detail's top bar: brings the
/// floating sidebar out, badged with the terminals waiting for the user (the 首页 tab's badge in
/// the compact layout). Pages place it themselves so it comes before their own leading items.
struct SidebarToggleButton: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation

    var body: some View {
        Button("显示边栏", systemImage: "sidebar.leading") {
            navigation.toggleOverlaySidebar()
        }
        .badge(client.waitingCount)
    }
}

extension View {
    /// Adds `SidebarToggleButton` to a detail page's top bar in the tall layout; elsewhere the
    /// sidebar is always beside the page or the page is in a tab.
    func sidebarToggleItem(client: CofluxClient) -> some View {
        modifier(SidebarToggleItem(client: client))
    }
}

private struct SidebarToggleItem: ViewModifier {
    let client: CofluxClient
    @Environment(\.shellLayout) private var layout

    func body(content: Content) -> some View {
        content.toolbar {
            if layout == .tall {
                ToolbarItem(placement: .topBarLeading) {
                    SidebarToggleButton(client: client)
                }
            }
        }
    }
}
