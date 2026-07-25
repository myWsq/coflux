import SwiftUI

/// 项目分组的工作区列表 + 设备在线/任务状态（验证 UI）。断线不清空内容：
/// 保留最后快照渲染，顶部横幅提示（store.ts:517-519 同语义）。
struct WorkspaceListView: View {
    let client: CofluxClient

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if client.status != .connected {
                    Text(client.status == .connecting ? "连接中…" : "连接已断开，恢复后自动重连")
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(.orange.opacity(0.2))
                }
                List {
                    ForEach(client.projects, id: \.id) { project in
                        Section {
                            let members = client.workspaces.filter { $0.projectID == project.id }
                            ForEach(members, id: \.id) { workspace in
                                workspaceRow(workspace)
                            }
                        } header: {
                            projectHeader(project)
                        }
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
            }
            .navigationTitle("工作区")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("登出") { client.logout() }
                }
            }
        }
    }

    private func projectHeader(_ project: Coflux_V1_Project) -> some View {
        let online = client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
        return HStack(spacing: 6) {
            Circle()
                .fill(online ? Color.green : Color.gray.opacity(0.4))
                .frame(width: 8, height: 8)
            Text(project.name)
        }
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let running = client.tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.name.isEmpty ? workspace.branch : workspace.name)
                Text(workspace.branch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if workspace.additions != 0 || workspace.deletions != 0 {
                Text("+\(workspace.additions) −\(workspace.deletions)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if running > 0 {
                Text("\(running)")
                    .font(.caption.bold())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.green.opacity(0.2)))
            }
        }
    }
}
