import SwiftUI

/// 工作区的任务列表。视觉延续 Cursor iOS：圆形返回钮 + 大标题 + 高行距 plain 列表，
/// 行 = 状态点 + 任务标题 + 元数据行。数据全部来自控制面归约器（plan 045：本片不动协议）。
struct TaskListView: View {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    @Environment(\.dismiss) private var dismiss

    private var members: [Coflux_V1_Task] {
        client.tasks
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(workspace.name.isEmpty ? workspace.branch : workspace.name)
                .font(.system(size: 34, weight: .bold))
                .lineLimit(1)
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 8)
            List {
                ForEach(members, id: \.id) { task in
                    NavigationLink {
                        TaskDetailView(client: client, taskID: task.id)
                    } label: {
                        taskRow(task)
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                    .listRowBackground(Color.black)
                    .listRowSeparatorTint(Color(white: 0.16))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .overlay {
                if members.isEmpty {
                    ContentUnavailableView(
                        "暂无任务",
                        systemImage: "square.terminal",
                        description: Text("在桌面端新建任务后此处会出现")
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var header: some View {
        HStack {
            CircleIconButton(systemName: "chevron.left") { dismiss() }
                .accessibilityLabel("返回")
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
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
                    .foregroundStyle(Color(white: 0.5))
            }
            Spacer()
        }
        .padding(.vertical, 12)
    }

    private func statusColor(_ task: Coflux_V1_Task) -> Color {
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? .orange : .green
        case .exited: return task.exitCode == 0 ? Color(white: 0.35) : .red
        default: return Color(white: 0.35)
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

/// Cursor 式圆形图标钮（深灰填充圆），顶栏通用。
struct CircleIconButton: View {
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(white: 0.75))
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color(white: 0.14)))
        }
    }
}
