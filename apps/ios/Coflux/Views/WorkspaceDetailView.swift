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
    /// 控制板展开态按工作区持久化（plan 058 复议 2026-07-26 默认折叠定案）：
    /// init 播种（onAppear 翻转会有可见跳变 + 一次多余 resize），变更时写回；
    /// UserDefaults.bool 缺省 false 恰为默认展开，纯新工作区免三态判断
    @State private var inputCollapsed: Bool
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
    /// 长按对讲会话（plan 064）：非 nil = 对讲态，浮层铺满屏幕；松手取消/完成
    /// 都清空。豆包优先、Apple 本地降级只在 session.start() 内部判定一次。
    @State private var dictationSession: DictationSession?
    @State private var dictationPendingCancel = false
    /// 成稿态（plan 066）：松手后同步置位，蒙层立即留驻展示草稿，不等
    /// session.finish() 落定；finish() 落定前 dictationFinalizing 拦发送。
    @State private var dictationReleased = false
    @State private var dictationFinalizing = false
    /// 逐任务离底态（plan 056）：true = 在底部。未上报（无输出/未滚动）视为在底
    @State private var atBottomByTask: [String: Bool] = [:]
    /// 逐任务底部空白（pt，TerminalHostView 上报）：未上报视为满屏（整量抬升）
    @State private var bottomSlackByTask: [String: CGFloat] = [:]

    /// 浮键列避开控制板的抬升量（恒 = 面板高）
    private var panelLift: CGFloat { inputCollapsed ? 0 : panelHeight }
    /// 终端抬升量 clamp 到内容真正需要让出的量：新终端内容在顶、下半屏
    /// 全空时不抬（整量抬会把唯一有内容的顶部裁掉，露出的却是空白）
    private var terminalLift: CGFloat {
        let slack = activeTaskID.flatMap { bottomSlackByTask[$0] } ?? 0
        return max(0, panelLift - slack)
    }

    init(client: CofluxClient, workspace: Coflux_V1_Workspace) {
        self.client = client
        self.workspace = workspace
        _inputCollapsed = State(initialValue: UserDefaults.standard.bool(forKey: Self.padCollapsedKey(workspace.id)))
    }

    private static func padCollapsedKey(_ workspaceID: String) -> String {
        "terminalPadCollapsed.\(workspaceID)"
    }
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
                        draft: draft,
                        onCompose: { setComposing(true) },
                        onDictateBegin: { beginDictation() },
                        onDictateMove: { dictationPendingCancel = $0 },
                        onDictateEnd: { endDictation(cancelled: $0) }
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
                onSend: { sendDraft() },
                onDismiss: { setComposing(false) }
            )
            // 毛玻璃底在内容层自绘并淡入淡出；呈现层禁默认滑入动画（见 setComposing）
            .presentationBackground(.clear)
        }
        .overlay(alignment: .bottomTrailing) {
            // 右下浮键列（plan 053 气泡 → 056 常驻两态 → 057 收编新建 → 058 定序）：
            // 瞬态键置列顶——滚到底浮现时列向上生长，常驻键（新建/键盘）零位移；
            // 键盘键守最下拇指位（折叠态=展开输入区、展开态=收起输入区，
            // 收起入口只此一处，输入区内不再有）。
            // 布局切换刻意不做动画：终端高度一步到位只触发一次 resize，
            // 动画期间逐帧 resize 会引发远端 TUI 重画闪动；过渡只给浮键自己
            ZStack {
                if !members.isEmpty {
                    VStack(spacing: 12) {
                        if let taskID = activeTask?.id, atBottomByTask[taskID] == false {
                            Button {
                                TerminalModeRegistry.shared.scrollToBottom(taskID: taskID)
                            } label: {
                                Image(systemName: "arrow.down.to.line")
                                    .font(Theme.Fonts.body.weight(.medium))
                                    .foregroundStyle(Theme.foreground)
                                    .frame(width: 52, height: 52)
                            }
                            .glassEffect(.regular.interactive(), in: .circle)
                            .accessibilityLabel("滚动到底部")
                            .transition(.scale.combined(with: .opacity))
                        }
                        Button {
                            createTerminal()
                        } label: {
                            Image(systemName: "plus")
                                .font(Theme.Fonts.body.weight(.medium))
                                .foregroundStyle(Theme.foreground)
                                .frame(width: 52, height: 52)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel("新建终端")
                        Button {
                            inputCollapsed.toggle()
                        } label: {
                            Image(systemName: inputCollapsed ? "keyboard" : "keyboard.chevron.compact.down")
                                .font(Theme.Fonts.body.weight(.medium))
                                .foregroundStyle(Theme.foreground)
                                .frame(width: 52, height: 52)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel(inputCollapsed ? "展开输入区" : "收起输入区")
                    }
                }
            }
            // 动画只作用于浮键容器内部（ZStack 常驻承接 transition），
            // 不外溢到布局——外溢会重新引入逐帧 resize 闪动
            .animation(.smooth(duration: 0.2), value: inputCollapsed)
            .animation(.smooth(duration: 0.2), value: atBottomByTask)
            .padding(.trailing, 20)
            .padding(.bottom, 24)
            // 展开时抬到控制板上方（纯 transform）：恒用整量面板高——
            // 终端侧 clamp 后可能不抬，浮键仍须让开面板
            .offset(y: -panelLift)
            .animation(.smooth(duration: 0.25), value: panelLift)
        }
        .overlay {
            // 对讲浮层：不用 fullScreenCover（对讲不涉及系统键盘，不需要成文层
            // 那套呈现层+冻结基座机制），纯 .overlay 铺满即可，叠在其它层之上
            if let dictationSession {
                DictationOverlay(
                    session: dictationSession,
                    pendingCancel: dictationPendingCancel,
                    released: dictationReleased,
                    finalizing: dictationFinalizing,
                    onDismiss: { closeDictationOverlay() },
                    onSend: {
                        sendText(dictationSession.displayText)
                        closeDictationOverlay()
                    },
                    onEdit: {
                        let text = dictationSession.displayText
                        closeDictationOverlay()
                        if !text.isEmpty { draft = text }
                        setComposing(true)
                    }
                )
            }
        }
        .animation(.easeOut(duration: 0.15), value: dictationSession != nil)
        .animation(.easeOut(duration: 0.15), value: dictationReleased)
        .background(Theme.background)
        .onChange(of: inputCollapsed) { _, collapsed in
            UserDefaults.standard.set(collapsed, forKey: Self.padCollapsedKey(workspace.id))
        }
        .navigationTitle(workspace.branch.isEmpty ? workspace.name : workspace.branch) // 主标题=分支，与 web 对齐
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
                // 自建任务直接启动（web performActivation 同语义）：新任务无 session，
                // TerminalHostView.bind 只对 RUNNING 任务发 attach，不补这发
                // 会停在「任务尚未启动」横幅等手动点启动
                client.startTask(taskID: mine, cols: termCols, rows: termRows)
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
                },
                onAtBottomChanged: { atBottomByTask[task.id] = $0 },
                onBottomSlackChanged: { bottomSlackByTask[task.id] = $0 }
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

    /// 发送文本到激活任务：单行字面文本原样落终端，不追加回车、不包
    /// bracketed paste（plan 054/055 复议 053——包裹依赖接收端 2004 模式，
    /// 未开时草稿内 \n 会被当回车执行，即真机「时灵时不灵」根因；提交时机
    /// 由用户按控制板大回车/对讲蒙层「发送」决定）。换行符只可能经粘贴/
    /// 语音混入，信任边界上以空格拍平。成文草稿与对讲成稿共用此路径
    /// （plan 066 landmine：蒙层发送不得绕过它自行写终端）。
    private func sendText(_ text: String) {
        guard let task = activeTask, task.status == .running, task.hasSessionID, !text.isEmpty else { return }
        let payload = text.components(separatedBy: .newlines).joined(separator: " ")
        client.sendInput(sessionID: task.sessionID, payload)
    }

    private func sendDraft() {
        sendText(draft)
        draft = ""
        // 呈现层的拆除由 overlay 的 fadeOutAndDismiss 统一走淡出时序，此处不拆
    }

    // MARK: - 长按对讲（plan 064；成稿态 plan 066）：占位条长按开始，上滑
    // 松手取消，直接松手完成——完成后蒙层留驻成稿：文字定格，发送直落
    // 终端 / 点文字进成文层编辑 / 弃掉拆层，不再自动弹成文层打断。

    private func beginDictation() {
        let session = DictationSession()
        dictationSession = session
        dictationPendingCancel = false
        dictationReleased = false
        dictationFinalizing = false
        session.begin()
    }

    private func closeDictationOverlay() {
        dictationSession = nil
        dictationReleased = false
        dictationFinalizing = false
    }

    /// 松手完成路径：蒙层立即切成稿态（不等 session.finish() 落定——草稿先
    /// 显示当前已转写文本，终稿到达后 session.displayText 原位更新）；
    /// finish() 仍必须在后台跑：松手即停止占用麦克风，不能拖到用户点发送
    /// 才释放（landmine）。finish() 落定后按结果收敛：权限被拒退回旧的
    /// 引导留驻态；无字可看的失败退回旧的错误留驻态；正常但空转写直接
    /// 拆层（无稿可确认）；其余（含失败但已有文字）留在成稿态。
    private func endDictation(cancelled: Bool) {
        guard let session = dictationSession else { return }
        dictationPendingCancel = false
        if cancelled {
            dictationSession = nil
            session.cancel()
            return
        }
        dictationReleased = true
        dictationFinalizing = true
        Task {
            let text = await session.finish()
            guard dictationSession === session else { return }
            dictationFinalizing = false
            switch session.phase {
            case .permissionDenied:
                // 不可能转写出文字，退回旧的引导留驻态（点任意处关闭）
                dictationReleased = false
            case .failed:
                // 无字可看的失败退回旧的错误留驻态；有字（如豆包中途断连）
                // 留在成稿态，浮层一并展示错误标注（decided 2026-07-30）
                if text.isEmpty { dictationReleased = false }
            default:
                if text.isEmpty {
                    // 空转写：无稿可确认，直接拆层（不再弹空成文层）
                    closeDictationOverlay()
                }
            }
        }
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
