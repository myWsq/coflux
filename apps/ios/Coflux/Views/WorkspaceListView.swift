import SwiftUI

/// 项目分组的工作区列表 + 设备在线/任务状态。断线不清空内容：
/// 保留最后快照渲染，顶部横幅提示（store.ts:517-519 同语义）。
/// 导航 chrome 走系统 NavigationStack（大标题 + toolbar），Liquid Glass 由系统提供；
/// 列表保持高行距 plain 风格、灰色常规体分组标题、行尾 chevron。
struct WorkspaceListView: View {
    let client: CofluxClient

    var body: some View {
        NavigationStack {
            List {
                ForEach(client.projects, id: \.id) { project in
                    Section {
                        let members = client.workspaces.filter { $0.projectID == project.id }
                        ForEach(members, id: \.id) { workspace in
                            NavigationLink {
                                WorkspaceDetailView(client: client, workspace: workspace)
                            } label: {
                                workspaceRow(workspace)
                            }
                            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                            .listRowBackground(Theme.background)
                            .listRowSeparatorTint(Theme.border)
                        }
                    } header: {
                        projectHeader(project)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .safeAreaInset(edge: .top, spacing: 0) {
                if client.status != .connected {
                    offlineBanner
                }
            }
            .overlay {
                if client.projects.isEmpty {
                    ContentUnavailableView(
                        "暂无项目",
                        systemImage: "tray",
                        description: Text("在桌面端导入 git 仓库后此处会出现")
                    )
                }
            }
            .navigationTitle("工作区")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("登出", role: .destructive) { client.logout() }
                    } label: {
                        Image(systemName: "person.fill")
                    }
                    .accessibilityLabel("账号")
                }
            }
        }
    }

    private var offlineBanner: some View {
        Label(
            client.status == .connecting ? "连接中…" : "连接已断开，恢复后自动重连",
            systemImage: client.status == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash"
        )
        .font(Theme.Fonts.label.weight(.medium))
        .foregroundStyle(Theme.warning)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Theme.warning.opacity(0.12))
    }

    private func projectHeader(_ project: Coflux_V1_Project) -> some View {
        let online = client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
        return HStack(spacing: 8) {
            Image("folder")
                .resizable()
                .scaledToFit()
                .frame(width: 15, height: 15)
                .foregroundStyle(Theme.mutedForeground)
            Text(project.name)
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.mutedForeground)
                .textCase(nil)
            Circle()
                .fill(online ? Theme.success : Theme.subtleForeground)
                .frame(width: 7, height: 7)
        }
        .padding(.vertical, 4)
        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let running = client.tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
        let name = workspace.name.isEmpty ? workspace.branch : workspace.name
        return HStack(spacing: 14) {
            // 与 web 侧栏同源：lucide GitBranch（asset 模板渲染），main 分支同 web 用 warning 色
            Image("git-branch")
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(workspace.isMain ? Theme.warning : Theme.mutedForeground)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(Theme.Fonts.body)
                if workspace.name.isEmpty == false, workspace.branch != workspace.name {
                    Text(workspace.branch)
                        .font(Theme.Fonts.label.monospaced())
                        .foregroundStyle(Theme.mutedForeground)
                }
            }
            Spacer()
            if workspace.additions != 0 || workspace.deletions != 0 {
                HStack(spacing: 4) {
                    Text("+\(workspace.additions)")
                        .foregroundStyle(Theme.success)
                    Text("−\(workspace.deletions)")
                        .foregroundStyle(Theme.destructive)
                }
                .font(Theme.Fonts.meta.monospacedDigit().weight(.medium))
            }
            if running > 0 {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Theme.success)
                        .frame(width: 6, height: 6)
                    Text("\(running)")
                        .font(Theme.Fonts.meta.monospacedDigit().weight(.semibold))
                }
                .foregroundStyle(Theme.success)
            }
        }
        .padding(.vertical, 12)
    }
}
