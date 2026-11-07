import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// The signed-in shell of one window. It measures its own window and picks a layout
/// (`ShellLayout`): compact and tall are a `TabView` (首页 / 设备) with one `NavigationStack` per
/// tab; split is a `NavigationSplitView` with the compact home as sidebar and the selected
/// terminal as detail. Rotating, opening or closing the Duo, entering Split View or resizing a
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
            // compact ⇄ tall keep one TabView (same branch); only split swaps the container.
            Group {
                if layout == .split {
                    splitLayout(fold: Self.bookFold(in: proxy))
                } else {
                    tabLayout
                }
            }
            .environment(\.shellLayout, layout)
        }
        .background(Theme.background)
        // A terminal created from home opens (and starts) as soon as it appears.
        .onChange(of: client.tasks.map(\.id)) { _, _ in
            openPendingTerminal()
        }
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
                    min: fold == nil ? 260 : sidebarWidth,
                    ideal: sidebarWidth,
                    max: fold == nil ? 360 : sidebarWidth
                )
        } detail: {
            detailColumn
                .padding(.leading, sidebarVisible ? (fold?.width ?? 0) : 0)
        }
    }

    @ViewBuilder
    private var detailColumn: some View {
        @Bindable var navigation = navigation
        if navigation.tab == .devices {
            NavigationStack(path: $navigation.devicePath) {
                DevicesView(client: client)
            }
        } else {
            NavigationStack {
                if let workspaceID = navigation.workspaceID {
                    WorkspacePage(client: client, workspaceID: workspaceID)
                        .id(workspaceID)
                } else {
                    ContentUnavailableView(
                        "选择一个终端",
                        systemImage: "terminal",
                        description: Text("从左栏选择工作区或等你处理的终端")
                    )
                    .background(Theme.background)
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
        }
    }
}
