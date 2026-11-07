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
                    splitLayout
                } else {
                    tabLayout
                }
            }
            .environment(\.shellLayout, layout)
        }
        .background(Theme.background)
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

    private var splitLayout: some View {
        @Bindable var navigation = navigation
        return NavigationSplitView(columnVisibility: $navigation.columnVisibility) {
            HomeSidebar(client: client)
        } detail: {
            detailColumn
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
        0
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

/// Placeholder sidebar for the split layout until the compact home lands (M2).
struct HomeSidebar: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation

    var body: some View {
        List {
            Section {
                Button {
                    navigation.tab = .devices
                } label: {
                    Label("设备", systemImage: "macbook.and.iphone")
                }
            }
            ForEach(client.visibleProjects, id: \.id) { project in
                Section(project.name) {
                    ForEach(client.workspaces.filter { $0.projectID == project.id }, id: \.id) { workspace in
                        Button(workspace.branch.isEmpty ? workspace.name : workspace.branch) {
                            navigation.show(workspaceID: workspace.id, taskID: nil)
                        }
                    }
                }
            }
        }
        .navigationTitle("coflux")
    }
}
