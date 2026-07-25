import SwiftUI

/// 项目分组的工作区列表 + 设备在线/任务状态。断线不清空内容：
/// 保留最后快照渲染，顶部横幅提示（store.ts:517-519 同语义）。
/// 视觉对标 Linear Mobile：plain 列表、弱化分组标题、行内状态徽标。
struct WorkspaceListView: View {
    let client: CofluxClient

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if client.status != .connected {
                    offlineBanner
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
                .listStyle(.plain)
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
                    Button {
                        client.logout()
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.subheadline)
                    }
                    .accessibilityLabel("登出")
                }
            }
        }
    }

    private var offlineBanner: some View {
        Label(
            client.status == .connecting ? "连接中…" : "连接已断开，恢复后自动重连",
            systemImage: client.status == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash"
        )
        .font(.footnote.weight(.medium))
        .foregroundStyle(.orange)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.orange.opacity(0.12))
    }

    private func projectHeader(_ project: Coflux_V1_Project) -> some View {
        let online = client.daemons.first { $0.daemonID == project.daemonID }?.online ?? false
        return HStack(spacing: 7) {
            Circle()
                .fill(online ? Color.green : Color.gray.opacity(0.4))
                .frame(width: 7, height: 7)
            Text(project.name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
        .padding(.vertical, 2)
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let running = client.tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
        let name = workspace.name.isEmpty ? workspace.branch : workspace.name
        return HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.branch")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.body.weight(.medium))
                if workspace.name.isEmpty == false, workspace.branch != workspace.name {
                    Text(workspace.branch)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if workspace.additions != 0 || workspace.deletions != 0 {
                HStack(spacing: 4) {
                    Text("+\(workspace.additions)")
                        .foregroundStyle(.green)
                    Text("−\(workspace.deletions)")
                        .foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit().weight(.medium))
            }
            if running > 0 {
                HStack(spacing: 4) {
                    Circle()
                        .fill(.green)
                        .frame(width: 6, height: 6)
                    Text("\(running)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                }
                .foregroundStyle(.green)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(.green.opacity(0.14)))
            }
        }
        .padding(.vertical, 6)
        .listRowSeparator(.hidden)
    }
}
