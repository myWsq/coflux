import SwiftUI

/// 工作区的任务列表：系统导航栏大标题 + 高行距 plain 列表，
/// 行 = 状态点 + 任务标题 + 元数据行。数据全部来自控制面归约器（plan 046：本片不动协议）。
struct TaskListView: View {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace

    private var members: [Coflux_V1_Task] {
        client.tasks
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        List {
            ForEach(members, id: \.id) { task in
                NavigationLink {
                    TaskDetailView(client: client, taskID: task.id)
                } label: {
                    taskRow(task)
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                .listRowBackground(Color(.systemBackground))
                .listRowSeparatorTint(Color(.separator))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.systemBackground))
        .overlay {
            if members.isEmpty {
                ContentUnavailableView {
                    Label {
                        Text("暂无任务")
                    } icon: {
                        Image("square-terminal")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 42, height: 42)
                    }
                } description: {
                    Text("在桌面端新建任务后此处会出现")
                }
            }
        }
        .navigationTitle(workspace.name.isEmpty ? workspace.branch : workspace.name)
    }

    private func taskRow(_ task: Coflux_V1_Task) -> some View {
        HStack(spacing: 14) {
            Circle()
                .fill(statusColor(task))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title.isEmpty ? "任务 \(task.id.prefix(6))" : task.title)
                    .font(.system(size: 19))
                    .lineLimit(1)
                Text(statusText(task))
                    .font(.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            Spacer()
        }
        .padding(.vertical, 12)
    }

    private func statusColor(_ task: Coflux_V1_Task) -> Color {
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? .orange : .green
        case .exited: return task.exitCode == 0 ? Color(.tertiaryLabel) : .red
        default: return Color(.tertiaryLabel)
        }
    }

    private func statusText(_ task: Coflux_V1_Task) -> String {
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? "运行中 · 已被其它客户端接管" : "运行中"
        case .exited: return task.hasExitCode ? "已退出 · exit \(task.exitCode)" : "已退出"
        case .idle: return "未启动"
        default: return "未知状态"
        }
    }
}
