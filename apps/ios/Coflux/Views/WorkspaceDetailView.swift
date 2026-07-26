import SwiftUI

/// 工作区任务台（plan 049）：终端不设二级页——顶部横向 tab 条 + 整页 paged
/// 滑动切换任务，结构对齐 mobile workspace-detail（进入即挂载全部任务页，
/// 各自 attach 保活；返回列表整体卸载）。新建终端沿 mobile 语义：taskCreate
/// 无请求-响应关联，记录发送前已知 id 集合，快照增量新出现的任务即自建、自动激活。
struct WorkspaceDetailView: View {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    @State private var activeTaskID: String?
    @State private var termCols: UInt32 = 80
    @State private var termRows: UInt32 = 24
    @State private var confirmingRemove = false
    @State private var knownTaskIDsBeforeCreate: Set<String>?

    /// tab 序 = 创建序（mobile 同序：createdAt 升序）
    private var members: [Coflux_V1_Task] {
        client.tasks
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private var activeTask: Coflux_V1_Task? {
        members.first { $0.id == activeTaskID }
    }

    var body: some View {
        VStack(spacing: 0) {
            if members.isEmpty {
                emptyState
            } else {
                tabBar
                TabView(selection: $activeTaskID) {
                    ForEach(members, id: \.id) { task in
                        taskPage(task)
                            .tag(Optional(task.id))
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .ignoresSafeArea(.container, edges: .bottom)
            }
        }
        .background(Color(.systemBackground))
        .navigationTitle(workspace.name.isEmpty ? workspace.branch : workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if activeTask != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("停止并删除任务", role: .destructive) { confirmingRemove = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("任务操作")
                }
            }
        }
        .confirmationDialog("删除任务？", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("停止并删除", role: .destructive) {
                if let task = activeTask {
                    Task { await client.closeTask(task) }
                }
            }
        } message: {
            Text("运行中的会话将被停止，任务从列表移除")
        }
        .onAppear {
            if activeTaskID == nil { activeTaskID = members.first?.id }
        }
        .onChange(of: members.map(\.id)) { _, ids in
            // 自建任务识别：差集而非"下一个新任务"（workspace-detail.tsx:188，防它端并发建任务误认）
            if let known = knownTaskIDsBeforeCreate,
               let mine = ids.first(where: { !known.contains($0) }) {
                activeTaskID = mine
                knownTaskIDsBeforeCreate = nil
            }
            // 激活任务被删除（本端或它端）：收敛到仍存在的页
            if let active = activeTaskID, !ids.contains(active) {
                activeTaskID = ids.last
            }
            if activeTaskID == nil { activeTaskID = ids.first }
        }
    }

    // MARK: - tab 条（内容组件非导航 chrome，自绘水平 chips）

    private var tabBar: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(members, id: \.id) { task in
                        tabChip(task)
                            .id(task.id)
                    }
                    Button {
                        createTerminal()
                    } label: {
                        Image(systemName: "plus")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color(.secondaryLabel))
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Color(.secondarySystemFill)))
                    }
                    .accessibilityLabel("新建终端")
                }
                .padding(.horizontal, 16)
            }
            .padding(.vertical, 6)
            .onChange(of: activeTaskID) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
            }
        }
    }

    private func tabChip(_ task: Coflux_V1_Task) -> some View {
        let active = task.id == activeTaskID
        return Button {
            activeTaskID = task.id
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor(task))
                    .frame(width: 6, height: 6)
                Text(task.title.isEmpty ? "任务 \(task.id.prefix(6))" : task.title)
                    .font(.footnote.weight(active ? .semibold : .regular))
                    .lineLimit(1)
            }
            .foregroundStyle(active ? Color.primary : Color(.secondaryLabel))
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(Capsule().fill(active ? Color(.secondarySystemFill) : .clear))
        }
    }

    private func statusColor(_ task: Coflux_V1_Task) -> Color {
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? .orange : .green
        case .exited: return task.exitCode == 0 ? Color(.tertiaryLabel) : .red
        default: return Color(.tertiaryLabel)
        }
    }

    // MARK: - 任务页（statusStrip + 终端，逐任务保活）

    private func taskPage(_ task: Coflux_V1_Task) -> some View {
        VStack(spacing: 0) {
            statusStrip(task)
            TerminalHostView(
                client: client,
                taskID: task.id,
                sessionID: task.hasSessionID ? task.sessionID : nil,
                isActive: task.id == activeTaskID,
                onSizeChanged: { cols, rows in
                    termCols = cols
                    termRows = rows
                }
            )
        }
    }

    private var emptyState: some View {
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
            Text("新建一个终端开始")
        } actions: {
            Button("新建终端") { createTerminal() }
                .buttonStyle(.borderedProminent)
        }
    }

    private func createTerminal() {
        knownTaskIDsBeforeCreate = Set(members.map(\.id))
        client.createTask(workspaceID: workspace.id, title: "终端 \(members.count + 1)")
    }

    // MARK: - 逐任务横幅（语义同 plan 046：接管/可启动/输入缓冲满）

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
                tint: Color(.secondaryLabel),
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
