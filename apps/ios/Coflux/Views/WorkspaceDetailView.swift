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
    @State private var inputCollapsed = true // 默认折叠成气泡（2026-07-26 用户定），阅读优先
    /// 无 resize 平移模型（plan 053）：终端容器尺寸恒定，被输入面板整体
    /// "顶上去"（offset 平移 + 裁剪），行列数不变 → 零 SIGWINCH 零重排。
    /// 位移量 = 面板实测高度（尺寸不受 transition 影响，量值稳定）；
    /// 平滑感来自 offset 自身的动画插值（纯 transform，不触发布局）。
    @State private var panelHeight: CGFloat = 0
    /// 手动键盘追踪：页面对键盘免疫（最外层 ignoresSafeArea(.keyboard)），
    /// 键盘弹起时手动把面板平移到"成文框骑在键盘顶上"的位置，
    /// 控制板下半部分被键盘盖住（2026-07-26 用户定案，取代蒙层方案）
    /// 成文层与系统键盘同层（fullScreenCover 透明底，无暗色蒙层）：
    /// 底下的终端/控制板完全冻结不动（2026-07-26 用户最终定案——
    /// 键盘骑乘/面板位移方案均已尝试并废弃，冻结基座手感最好）
    @State private var composing = false
    @State private var draft = ""

    private var terminalLift: CGFloat { inputCollapsed ? 0 : panelHeight }
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
                // 横幅挪出终端页（终端会被面板顶上去裁顶，横幅必须常驻可见）
                if let task = activeTask {
                    statusStrip(task)
                }
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
                // 平移而非缩放：终端整体被顶上去，顶部裁掉（scrollback 仍可
                // 在终端内滚动回看；完整画面 = 收起面板）。
                // 动画挂在 offset 上：与面板同曲线同时长，一起滑动
                .offset(y: -terminalLift)
                .animation(.smooth(duration: 0.25), value: terminalLift)
                .clipped()
                // 终端页与系统键盘绝缘：键盘只属于模态成文层
                .ignoresSafeArea(.keyboard)
            }
        }
        .overlay(alignment: .bottom) {
            ZStack {
                if !inputCollapsed, !members.isEmpty {
                    TerminalInputArea(
                        client: client,
                        task: activeTask,
                        collapsed: $inputCollapsed,
                        draft: draft,
                        onCompose: { setComposing(true) }
                    )
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { height in
                        panelHeight = height
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.smooth(duration: 0.25), value: inputCollapsed)
        }
        // 基座对系统键盘免疫（冻结）；成文层走独立呈现上下文与键盘同层
        .ignoresSafeArea(.keyboard)
        .fullScreenCover(isPresented: $composing) {
            TerminalComposeOverlay(
                draft: $draft,
                onSend: { newline in sendDraft(newline: newline) },
                onDismiss: { setComposing(false) }
            )
            // 毛玻璃底在内容层自绘并淡入淡出；呈现层禁默认滑入动画（见 setComposing）
            .presentationBackground(.clear)
        }
        .overlay(alignment: .bottomTrailing) {
            // 折叠态：右下角玻璃气泡（plan 053，用户定案 AssistiveTouch 式）。
            // 布局切换刻意不做动画：终端高度一步到位只触发一次 resize，
            // 动画期间逐帧 resize 会引发远端 TUI 重画闪动；过渡只给气泡自己
            ZStack {
                if inputCollapsed, !members.isEmpty {
                    Button {
                        inputCollapsed = false
                    } label: {
                        Image(systemName: "keyboard")
                            .font(Theme.Fonts.body.weight(.medium))
                            .foregroundStyle(Theme.foreground)
                            .frame(width: 52, height: 52)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("展开输入区")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            // 动画只作用于气泡容器内部（ZStack 常驻承接 transition），
            // 不外溢到布局——外溢会重新引入逐帧 resize 闪动
            .animation(.smooth(duration: 0.2), value: inputCollapsed)
            .padding(.trailing, 20)
            .padding(.bottom, 24)
        }
        .background(Theme.background)
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
                            .font(Theme.Fonts.label.weight(.semibold))
                            .foregroundStyle(Theme.mutedForeground)
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
                    .font(Theme.Fonts.label.weight(active ? .semibold : .regular))
                    .lineLimit(1)
            }
            .foregroundStyle(active ? Theme.foreground : Theme.mutedForeground)
            .padding(.horizontal, 12)
            .frame(height: 30)
        }
    }

    private func statusColor(_ task: Coflux_V1_Task) -> Color {
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? Theme.warning : Theme.success
        case .exited: return task.exitCode == 0 ? Theme.subtleForeground : Theme.destructive
        default: return Theme.subtleForeground
        }
    }

    // MARK: - 任务页（statusStrip + 终端，逐任务保活）

    private func taskPage(_ task: Coflux_V1_Task) -> some View {
        VStack(spacing: 0) {
            TerminalHostView(
                client: client,
                taskID: task.id,
                sessionID: task.hasSessionID ? task.sessionID : nil,
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
                .tint(Theme.primary)
        }
    }

    private func createTerminal() {
        knownTaskIDsBeforeCreate = Set(members.map(\.id))
        client.createTask(workspaceID: workspace.id, title: "终端 \(members.count + 1)")
    }

    /// fullScreenCover 默认自下滑入/滑出；成文层要的是背景淡入淡出（内容层
    /// 自己做 fade），故呈现切换一律禁系统动画
    private func setComposing(_ on: Bool) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { composing = on }
    }

    /// 发送成文草稿到激活任务。多行包 bracketed paste 防换行被行编辑器当提交
    /// （Claude Code/zsh 均开 2004 模式，2026-07-26 实测）。
    private func sendDraft(newline: Bool) {
        guard let task = activeTask, task.status == .running, task.hasSessionID, !draft.isEmpty else { return }
        var payload = draft
        if payload.contains("\n") {
            payload = "\u{1b}[200~" + payload + "\u{1b}[201~"
        }
        client.sendInput(sessionID: task.sessionID, newline ? payload + "\r" : payload)
        draft = ""
        // 呈现层的拆除由 overlay 的 fadeOutAndDismiss 统一走淡出时序，此处不拆
    }


    // MARK: - 逐任务横幅（语义同 plan 046：接管/可启动/输入缓冲满）

    @ViewBuilder
    private func statusStrip(_ task: Coflux_V1_Task) -> some View {
        if client.detachedTaskIDs.contains(task.id) {
            banner(
                text: "已被其它客户端接管，当前为旁观视图",
                icon: "eye",
                tint: Theme.warning,
                actionLabel: "强制接管"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows, force: true)
            }
        } else if task.status != .running {
            banner(
                text: task.status == .exited ? "会话已退出" : "任务尚未启动",
                icon: "play.circle",
                tint: Theme.mutedForeground,
                actionLabel: "启动"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows)
            }
        } else if task.hasSessionID, client.blockedSessionIDs.contains(task.sessionID) {
            banner(text: "终端输入等待确认，缓冲区已满", icon: "hourglass", tint: Theme.warning, actionLabel: nil, action: nil)
        }
    }

    @ViewBuilder
    private func banner(text: String, icon: String, tint: Color, actionLabel: String?, action: (() -> Void)?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(Theme.Fonts.label)
            Text(text)
                .font(Theme.Fonts.label.weight(.medium))
                .lineLimit(1)
            Spacer()
            if let actionLabel, let action {
                Button(action: action) {
                    Text(actionLabel)
                        .font(Theme.Fonts.label.weight(.semibold))
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
