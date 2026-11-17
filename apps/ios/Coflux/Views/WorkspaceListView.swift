import CofluxClientCore
import CofluxProtocol
import SwiftUI

/// 首页 of the compact layout (the outer display): the sections of the inner display's sidebar
/// without the devices, which have their own tab — 「当前」, the live agent terminals, then the
/// projects, collapsed until opened (`HomeSections`, plan 20261115-ios-current-section). No cards
/// and no page title — the outer display is short, so content starts at the top. A dropped
/// connection does not empty the page: the last snapshot stays, under a banner. Opening a row goes
/// through `SceneNavigation.show`.
struct WorkspaceListView: View {
    let client: CofluxClient
    @Environment(SceneNavigation.self) private var navigation
    @State private var showingNewTerminal = false
    @State private var secretSheet: SecretSheetTarget?
    @State private var showingSettings = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                HomeSections(client: client, surface: .stack, onOpen: open)
            }
            .padding(.bottom, 24)
        }
        .expandsShownWorkspace(client: client)
        .scrollIndicators(.hidden)
        .background(Theme.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            ConnectionBanner(client: client)
        }
        .overlay {
            if client.visibleProjects.isEmpty, client.currentTerminals.isEmpty {
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

    /// A 「当前」 row: its terminal, or — as this page always did for a secret request — the input
    /// sheet over the home.
    private func open(_ row: CurrentTerminalRow) {
        if row.secret != nil {
            secretSheet = SecretSheetTarget(taskID: row.task.id)
        } else {
            navigation.show(workspaceID: row.workspace.id, taskID: row.task.id)
        }
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
