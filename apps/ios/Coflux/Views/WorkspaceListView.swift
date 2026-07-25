import SwiftUI

/// 项目分组的工作区列表 + 设备在线/任务状态。断线不清空内容：
/// 保留最后快照渲染，顶部横幅提示（store.ts:517-519 同语义）。
/// 视觉对标 Cursor iOS：真黑底、圆形头像钮 + 独立大标题、
/// 高行距 plain 列表、灰色常规体分组标题、行尾 chevron。
struct WorkspaceListView: View {
    let client: CofluxClient

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                header
                Text("工作区")
                    .font(.system(size: 34, weight: .bold))
                    .padding(.horizontal, 20)
                    .padding(.top, 20)
                    .padding(.bottom, 8)
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
                .scrollContentBackground(.hidden)
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    /// Cursor 式顶栏：左侧圆形头像钮（收纳账号操作），标准 nav bar 隐藏
    private var header: some View {
        HStack {
            Menu {
                Button("登出", role: .destructive) { client.logout() }
            } label: {
                Image(systemName: "person.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color(white: 0.75))
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color(white: 0.14)))
            }
            .accessibilityLabel("账号")
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
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
        return HStack(spacing: 8) {
            Image(systemName: "folder")
                .font(.subheadline)
                .foregroundStyle(Color(white: 0.55))
            Text(project.name)
                .font(.body)
                .foregroundStyle(Color(white: 0.55))
                .textCase(nil)
            Circle()
                .fill(online ? Color.green : Color(white: 0.3))
                .frame(width: 7, height: 7)
        }
        .padding(.vertical, 4)
        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
    }

    private func workspaceRow(_ workspace: Coflux_V1_Workspace) -> some View {
        let running = client.tasks.filter { $0.workspaceID == workspace.id && $0.status == .running }.count
        let name = workspace.name.isEmpty ? workspace.branch : workspace.name
        return HStack(spacing: 14) {
            // 与 web 侧栏对齐：lucide GitBranch ≈ SF arrow.branch，main 分支同 web 用 warning 色
            Image(systemName: "arrow.branch")
                .font(.body)
                .foregroundStyle(workspace.isMain ? Color.orange : Color(white: 0.55))
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.system(size: 19))
                if workspace.name.isEmpty == false, workspace.branch != workspace.name {
                    Text(workspace.branch)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Color(white: 0.5))
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
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color(white: 0.35))
        }
        .padding(.vertical, 12)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowBackground(Color.black)
        .listRowSeparatorTint(Color(white: 0.16))
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
    }
}
