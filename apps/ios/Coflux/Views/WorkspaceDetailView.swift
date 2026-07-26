import SwiftUI

/// 工作区任务台（plan 049）：终端不设二级页——顶部横向 tab 条 + 整页 paged
/// 滑动切换任务，结构对齐 mobile workspace-detail（进入即挂载全部任务页，
/// 各自 attach 保活；返回列表整体卸载）。新建终端沿 mobile 语义：taskCreate
/// 无请求-响应关联，记录发送前已知 id 集合，快照增量新出现的任务即自建、自动激活。
struct WorkspaceDetailView: View {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var activeTaskID: String?
    @State private var termCols: UInt32 = 80
    @State private var termRows: UInt32 = 24
    @State private var confirmingRemove = false
    @State private var knownTaskIDsBeforeCreate: Set<String>?
    /// 翻页连续进度（小数页索引）与 chip 框架缓存：药丸跟手滑动的两个输入
    @State private var pageProgress: CGFloat = 0
    @State private var chipFrames: [String: CGRect] = [:]

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
                // 分页容器用 ScrollView 而非 TabView(.page)：后者不暴露连续
                // 滚动进度，药丸只能落定后追赶（"不跟手"，plan 050 返工点）
                ScrollView(.horizontal) {
                    HStack(spacing: 0) {
                        ForEach(members, id: \.id) { task in
                            taskPage(task)
                                .containerRelativeFrame(.horizontal)
                                .id(task.id)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: $activeTaskID)
                .scrollIndicators(.hidden)
                .onScrollGeometryChange(for: CGFloat.self) { geo in
                    geo.containerSize.width > 0 ? geo.contentOffset.x / geo.containerSize.width : 0
                } action: { _, value in
                    pageProgress = value
                }
                // 第一页继续往回滑 = 返回工作区列表：松手瞬间（离开拖拽相位）
                // 左缘回弹超过 12% 页宽即 pop，一次手势只判定一次
                .onScrollPhaseChange { oldPhase, _, context in
                    guard oldPhase == .interacting || oldPhase == .tracking else { return }
                    let width = context.geometry.containerSize.width
                    guard width > 0 else { return }
                    if context.geometry.contentOffset.x / width < -0.12 {
                        dismiss()
                    }
                }
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

    // MARK: - tab 条（内容组件非导航 chrome；激活指示 = 单一常驻玻璃药丸，
    // 位置按翻页连续进度在相邻 chip 框架间插值 → 跟手滑动，plan 050）

    private var tabBar: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(members, id: \.id) { task in
                        tabChip(task)
                            .onGeometryChange(for: CGRect.self) { proxy in
                                proxy.frame(in: .named("chipBar"))
                            } action: { frame in
                                chipFrames[task.id] = frame
                            }
                            .id(task.id)
                    }
                    Button {
                        createTerminal()
                    } label: {
                        Image(systemName: "plus")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color(.secondaryLabel))
                            .frame(width: 30, height: 30)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("新建终端")
                }
                .padding(.horizontal, 16)
                // 垂直留白必须在 ScrollView 内容里而非外面：药丸边缘高光
                // 贴着滚动容器裁剪边界会被切掉（真机踩过）
                .padding(.vertical, 6)
                .coordinateSpace(.named("chipBar"))
                .background {
                    if let frame = pillFrame() {
                        Color.clear
                            .glassEffect(.regular, in: .capsule)
                            .frame(width: frame.width, height: frame.height)
                            .position(x: frame.midX, y: frame.midY)
                    }
                }
            }
            .onChange(of: activeTaskID) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
            }
        }
    }

    /// 药丸目标框架：翻页进度的整数部分定相邻 chip 对，小数部分线性插值。
    private func pillFrame() -> CGRect? {
        let ids = members.map(\.id)
        guard !ids.isEmpty else { return nil }
        let progress = min(max(pageProgress, 0), CGFloat(ids.count - 1))
        let index = Int(progress.rounded(.down))
        let fraction = progress - CGFloat(index)
        guard let from = chipFrames[ids[index]] else { return nil }
        guard fraction > 0, index + 1 < ids.count, let to = chipFrames[ids[index + 1]] else { return from }
        return CGRect(
            x: from.minX + (to.minX - from.minX) * fraction,
            y: from.minY + (to.minY - from.minY) * fraction,
            width: from.width + (to.width - from.width) * fraction,
            height: from.height + (to.height - from.height) * fraction
        )
    }

    private func tabChip(_ task: Coflux_V1_Task) -> some View {
        let active = task.id == activeTaskID
        return Button {
            withAnimation(.smooth(duration: 0.3)) { activeTaskID = task.id }
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
