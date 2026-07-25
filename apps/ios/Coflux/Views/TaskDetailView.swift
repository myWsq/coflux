import SwiftUI

/// 任务详情 = 终端现场。语义对照 web workbench 终端 tab：
/// - RUNNING：attach 现场 + 键盘输入 + 独占接管（被接管出横幅，force 夺回）
/// - IDLE/EXITED：可启动（taskStart → 中心 prepared create）；无 live 时 checkpoint 只读回放
/// - 删除任务 = stop + taskRemove（closeTask 语义）
struct TaskDetailView: View {
    let client: CofluxClient
    let taskID: String
    @Environment(\.dismiss) private var dismiss
    @State private var termCols: UInt32 = 80
    @State private var termRows: UInt32 = 24
    @State private var confirmingRemove = false

    private var task: Coflux_V1_Task? {
        client.tasks.first { $0.id == taskID }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let task {
                statusStrip(task)
                TerminalHostView(
                    client: client,
                    taskID: taskID,
                    sessionID: task.hasSessionID ? task.sessionID : nil,
                    onSizeChanged: { cols, rows in
                        termCols = cols
                        termRows = rows
                    }
                )
                .ignoresSafeArea(.container, edges: .bottom)
            } else {
                // 任务已被删除（本端或它端）：现场不复存在
                ContentUnavailableView("任务不存在", systemImage: "square.terminal")
                    .frame(maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black)
        .toolbar(.hidden, for: .navigationBar)
        .confirmationDialog("删除任务？", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("停止并删除", role: .destructive) {
                if let task {
                    Task { await client.closeTask(task) }
                    dismiss()
                }
            }
        } message: {
            Text("运行中的会话将被停止，任务从列表移除")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            CircleIconButton(systemName: "chevron.left") { dismiss() }
                .accessibilityLabel("返回")
            VStack(alignment: .leading, spacing: 1) {
                Text(task.map { $0.title.isEmpty ? "任务 \($0.id.prefix(6))" : $0.title } ?? "任务")
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                if let task {
                    Text(headerSubtitle(task))
                        .font(.caption)
                        .foregroundStyle(Color(white: 0.5))
                }
            }
            Spacer()
            if task != nil {
                Menu {
                    Button("停止并删除任务", role: .destructive) { confirmingRemove = true }
                } label: {
                    CircleIconButton(systemName: "ellipsis") {}
                        .allowsHitTesting(false)
                }
                .accessibilityLabel("任务操作")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
    }

    private func headerSubtitle(_ task: Coflux_V1_Task) -> String {
        switch task.status {
        case .running: return "运行中"
        case .exited: return task.hasExitCode ? "已退出 · exit \(task.exitCode)" : "已退出"
        case .idle: return "未启动"
        default: return ""
        }
    }

    @ViewBuilder
    private func statusStrip(_ task: Coflux_V1_Task) -> some View {
        if client.detachedTaskIDs.contains(task.id) {
            banner(
                text: "已被其它客户端接管，当前为旁观视图",
                icon: "eye",
                tint: .orange,
                actionLabel: "强制接管"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows, force: true)
            }
        } else if task.status != .running {
            banner(
                text: task.status == .exited ? "会话已退出" : "任务尚未启动",
                icon: "play.circle",
                tint: Color(white: 0.6),
                actionLabel: "启动"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows)
            }
        } else if task.hasSessionID, client.blockedSessionIDs.contains(task.sessionID) {
            banner(text: "终端输入等待确认，缓冲区已满", icon: "hourglass", tint: .orange, actionLabel: nil, action: nil)
        }
    }

    @ViewBuilder
    private func banner(text: String, icon: String, tint: Color, actionLabel: String?, action: (() -> Void)?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.footnote)
            Text(text)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
            Spacer()
            if let actionLabel, let action {
                Button(action: action) {
                    Text(actionLabel)
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(tint.opacity(0.22)))
                }
            }
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(tint.opacity(0.10))
    }
}
