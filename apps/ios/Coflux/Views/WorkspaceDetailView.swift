import CofluxClientCore
import CofluxProtocol
import SwiftUI
import UIKit

/// The terminal page (plan 049 → Duo redesign, plan D3/D13/D16): the active terminal fills the
/// content area down to the resting dock; every terminal of the workspace stays mounted in a
/// horizontal pager (swipe to switch, each attached and kept alive; leaving the page unmounts
/// them). All chrome is the system's: the navigation title names the terminal, and the toolbar
/// carries 终端 (the terminal list), 附件, 按键 (the full keypad) and 更多 — on the outer display the
/// system draws them on the vertical rail. Status banners sit in a strip at the top of the content.
///
/// 新建终端沿 mobile 语义：taskCreate 无请求-响应关联，记录发送前已知 id 集合，快照增量新出现的
/// 任务即自建、自动激活并启动。
struct WorkspaceDetailView: View {
    let client: CofluxClient
    let workspace: Coflux_V1_Workspace
    /// The window's navigation: the active terminal lives there (per workspace), so a layout
    /// switch that rebuilds this page lands on the same terminal, and cards / sidebar / list can
    /// request one.
    @Environment(SceneNavigation.self) private var navigation
    /// Which window owns each terminal (plan D12): only owned terminals get a terminal view.
    @Environment(TerminalOwnership.self) private var ownership
    @Environment(\.shellLayout) private var layout
    /// This mounted page's claims; released when SwiftUI tears the page down.
    @State private var claims = TerminalClaimHolder()
    @State private var termCols: UInt32 = 80
    @State private var termRows: UInt32 = 24
    @State private var confirmingRemove = false
    @State private var knownTaskIDsBeforeCreate: Set<String>?
    /// 成文层与系统键盘同层（fullScreenCover 透明底）：底下的终端与 dock 完全冻结不动
    /// （2026-07-26 用户最终定案，冻结基座手感最好；打字时不触发 resize）
    @State private var composing = false
    @State private var draft = ""
    /// 长按对讲会话（plan 064）：非 nil = 已在采音；松手分发完清空。
    @State private var dictationSession: DictationSession?
    /// 蒙层可见性（plan 069）：与 session 生命周期解耦——预热期 session 已在采音而蒙层还不显示。
    @State private var dictationOverlayVisible = false
    /// 手指当前命中的按钮（plan 068）：蒙层拿它做高亮/提示，松手也按它分发。
    @State private var dictationZone: DictationZone = .none
    /// 蒙层在全局坐标系里的框：按钮位置由它推出，命中判定与按钮绘制同源。
    @State private var dictationBounds: CGRect = .zero
    /// 蒙层相位（plan 068）：listening → finalizing → settled。
    @State private var dictationStage: DictationStage = .listening
    /// 逐任务离底态（plan 056）：true = 在底部。未上报（无输出/未滚动）视为在底
    @State private var atBottomByTask: [String: Bool] = [:]
    /// The dock's resting height (key row + composer, never the notice bar): the terminal ends
    /// above it, so neither the notice bar nor the keyboard resizes the terminal (D13).
    @State private var restingDockHeight: CGFloat = 0
    /// The page's content size: decides the short-window fold and where the toolbar items go.
    @State private var pageSize: CGSize = .zero
    @State private var showingKeypad = false
    @State private var showingPhotoPicker = false
    @State private var showingFilePicker = false
    @State private var secretSheet: SecretSheetTarget?
    /// Tall layout, half folded with a horizontal fold: the keypad is inline below the fold and
    /// the 按键 toolbar item goes away (plan D9).
    @State private var laptopPose = false

    /// Below this content height the key row folds into 按键 and only the composer stays
    /// (tall Split View, outer display in landscape): the terminal keeps its rows.
    static let shortPageHeight: CGFloat = 470

    private var activeTaskID: String? {
        get { navigation.activeTaskID(in: workspace.id) }
        nonmutating set { navigation.setActiveTask(newValue, in: workspace.id) }
    }

    private var activeTaskBinding: Binding<String?> {
        Binding(
            get: { navigation.activeTaskID(in: workspace.id) },
            set: { navigation.setActiveTask($0, in: workspace.id) }
        )
    }

    /// 页序 = 创建序（createdAt 升序）
    private var members: [Coflux_V1_Task] {
        client.tasks
            .filter { $0.workspaceID == workspace.id }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private var activeTask: Coflux_V1_Task? {
        members.first { $0.id == activeTaskID }
    }

    private var shortWindow: Bool {
        layout != .tall && pageSize.height > 0 && pageSize.height < Self.shortPageHeight
    }

    /// 附件 / 按键 go to the bottom bar (the lower end of the rail on the outer display and in the
    /// split detail) unless the window lays its bars out horizontally and short: then everything
    /// stays in the top bar, as in the tall layout.
    private var bottomBarItems: Bool {
        layout != .tall && pageSize.height >= pageSize.width
    }

    // MARK: - Titles

    /// A directory workspace (no repository) is the device's terminal: the device names the page.
    /// 「目录工作区由设备命名」是工作区种类的属性而不是调用方偏好，故在此解析。
    private var deviceLabel: String {
        client.deviceName(workspace.daemonID)
    }

    private func terminalName(_ task: Coflux_V1_Task) -> String {
        if let agent = client.agent(forTask: task), !agent.agent.isEmpty { return agent.agent }
        return taskTitle(task)
    }

    private var titleText: String {
        if isDirWorkspace(workspace) {
            let label = deviceLabel
            return label.isEmpty ? workspace.name : label
        }
        return activeTask.map(terminalName) ?? workspace.displayTitle
    }

    private var subtitleText: String {
        if isDirWorkspace(workspace) {
            return activeTask.map(terminalName) ?? ""
        }
        let project = client.projects.first { $0.id == workspace.projectID }?.name ?? workspace.displayTitle
        return [project, deviceLabel].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func taskTitle(_ task: Coflux_V1_Task) -> String {
        task.title.isEmpty ? "任务 \(task.id.prefix(6))" : task.title
    }

    // MARK: - Body

    var body: some View {
        pageContent
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.terminal)
            // 基座对系统键盘免疫（冻结）；成文层走独立呈现上下文与键盘同层
            .ignoresSafeArea(.keyboard)
            .overlay {
                // 对讲浮层：不涉及系统键盘，纯 .overlay 铺满即可，叠在其它层之上
                if dictationOverlayVisible, let dictationSession {
                    DictationOverlay(
                        session: dictationSession,
                        zone: dictationZone,
                        stage: dictationStage,
                        onDiscard: { closeDictationOverlay() },
                        onSend: { sendDictation() },
                        onEdit: { editDictation() }
                    )
                }
            }
            // 按钮几何真相源：蒙层就铺在这个框里，按钮由 DictationZone.Geometry 从框的尺寸推出，
            // 命中判定（全局坐标）与蒙层绘制（对齐自身）同源
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .global)
            } action: { frame in
                dictationBounds = frame
                pageSize = frame.size
            }
            .animation(.easeOut(duration: 0.15), value: dictationOverlayVisible)
            .navigationTitle(titleText)
            .navigationSubtitle(subtitleText)
            .navigationBarTitleDisplayMode(.inline)
            // The bottom of the rail belongs to this page's toolbar, not the tab bar.
            .toolbar(.hidden, for: .tabBar)
            .toolbar { toolbarContent }
            .fullScreenCover(isPresented: $composing) {
                TerminalComposeOverlay(
                    draft: $draft,
                    ready: terminalReady,
                    placeholder: composerPlaceholder,
                    onSend: { sendDraft(withEnter: $0) },
                    onPhoto: { data, type in keySender.uploadImage(data: data, typeIdentifier: type, prefix: "photo") },
                    onDismiss: { setComposing(false) }
                )
                // 毛玻璃底在内容层自绘并淡入淡出；呈现层禁默认滑入动画（见 setComposing）
                .presentationBackground(.clear)
            }
            .sheet(isPresented: $showingKeypad) {
                TerminalKeypad(client: client, task: activeTask, onClose: { showingKeypad = false })
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                    // A detent that leaves the terminal's upper part visible and usable: the panel
                    // stays open while keys are pressed.
                    .presentationDetents([.height(372), .large])
                    .presentationBackgroundInteraction(.enabled(upThrough: .height(372)))
                    .presentationBackground(Theme.card)
                    .presentationCornerRadius(34)
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingPhotoPicker) {
                PhotoPicker(isPresented: $showingPhotoPicker) { data, typeIdentifier in
                    keySender.uploadImage(data: data, typeIdentifier: typeIdentifier, prefix: "photo")
                }
            }
            .sheet(isPresented: $showingFilePicker) {
                FilePicker(isPresented: $showingFilePicker) { url in
                    keySender.uploadFile(url: url)
                }
            }
            .sheet(item: $secretSheet) { target in
                SecretRequestSheet(client: client, taskID: target.taskID)
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
                if activeTaskID == nil || !members.contains(where: { $0.id == activeTaskID }) {
                    activeTaskID = members.first?.id
                }
                claims.attach(ownership)
                claimTerminals(activating: activeTaskID)
            }
            // Activating a terminal (swipe, list, card, sidebar) takes it from another window.
            .onChange(of: activeTaskID) { _, id in
                claimTerminals(activating: id)
            }
            // Terminals nobody owns (new ones, or ones another window let go) are taken quietly.
            .onChange(of: unownedTaskIDs) { _, _ in
                claimTerminals(activating: nil)
            }
            .onChange(of: members.map(\.id)) { _, ids in
                // 自建任务识别：差集而非"下一个新任务"（workspace-detail.tsx:188，防它端并发建任务误认）
                if let known = knownTaskIDsBeforeCreate,
                   let mine = ids.first(where: { !known.contains($0) }) {
                    activeTaskID = mine
                    knownTaskIDsBeforeCreate = nil
                    // 自建任务直接启动：新任务无 session，TerminalHostView.bind 只对 RUNNING 任务发
                    // attach，不补这发会停在「任务尚未启动」横幅等手动点启动
                    client.startTask(taskID: mine, cols: termCols, rows: termRows)
                }
                // 激活任务被删除（本端或它端）：收敛到仍存在的页
                if let active = activeTaskID, !ids.contains(active) {
                    activeTaskID = ids.last
                }
                if activeTaskID == nil { activeTaskID = ids.first }
            }
    }

    @ViewBuilder
    private var pageContent: some View {
        if members.isEmpty {
            emptyState
        } else if layout == .tall {
            tallArrangement
        } else {
            ZStack(alignment: .bottom) {
                terminalColumn(reserveDock: true)
                dock(inlineKeypad: false)
            }
        }
    }

    /// The tall layout (mockup T1/T2, plan D9): the whole page is one overlay arrangement — the
    /// pager of terminals as the secondary view, the input area as the primary one. Fully open
    /// there is no dividing region: the input overlays the terminal exactly as in the other
    /// layouts, and the terminal ends above the resting dock. Half folded with a horizontal fold
    /// (laptop pose) the system places the terminal before the fold and the input after it; the
    /// input then carries the full keypad inline. The pose is read from the reserved regions only
    /// — never from sensors or the window size — and both changes land in the same layout pass,
    /// so the transition resizes the terminal once.
    private var tallArrangement: some View {
        GeometryReader { proxy in
            let laptop = Self.isLaptopPose(proxy)
            ArrangementView {
                dock(inlineKeypad: laptop)
                    .frame(maxHeight: .infinity, alignment: laptop ? .top : .bottom)
                    .overlayArrangementEdge(VerticalEdge.bottom)
            } secondary: {
                terminalColumn(reserveDock: !laptop)
            }
            // Overlay, not split: fully open the keypad must not stay on screen.
            .arrangementViewStyle(OverlayArrangementViewStyle().axes(.vertical))
            .onChange(of: laptop, initial: true) { _, isLaptop in
                laptopPose = isLaptop
            }
        }
    }

    /// An active dividing region running horizontally across the page: the laptop pose.
    private static func isLaptopPose(_ proxy: GeometryProxy) -> Bool {
        proxy.reservedRegions(kind: .division).contains { $0.isActive && $0.frame.width > $0.frame.height }
    }

    /// Status strip + the pager. With `reserveDock` the terminal ends above the resting dock.
    private func terminalColumn(reserveDock: Bool) -> some View {
        VStack(spacing: 0) {
            if let task = activeTask {
                statusStrip(task)
            }
            pager
                .overlay(alignment: .bottomTrailing) {
                    scrollToBottomButton
                }
        }
        .padding(.bottom, reserveDock ? restingDockHeight : 0)
    }

    /// 分页容器用 ScrollView：全部任务页同时挂载（各自 attach 保活），左右滑动切换。第一页再往回
    /// 滑不再返回列表（D16）：返回只走系统返回。
    private var pager: some View {
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
        .scrollPosition(id: activeTaskBinding)
        .scrollIndicators(.hidden)
        .clipped()
        // 终端页与系统键盘绝缘：键盘只属于模态成文层
        .ignoresSafeArea(.keyboard)
    }

    private func dock(inlineKeypad: Bool) -> some View {
        TerminalInputArea(
            client: client,
            task: activeTask,
            draft: draft,
            foldKeyRow: shortWindow && !inlineKeypad,
            inlineKeypad: inlineKeypad,
            onCompose: { setComposing(true) },
            onSend: { withEnter in sendFromDock(withEnter: withEnter) },
            onOpenSecret: { openSecretSheet() },
            onDictatePrewarm: { prewarmDictation() },
            onDictateBegin: { beginDictation() },
            onDictateMove: { dictationZone = DictationZone.hit($0, in: dictationBounds) },
            onDictateEnd: { endDictation() },
            onDictateAbort: { abortDictation() }
        )
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            if !inlineKeypad { restingDockHeight = height }
        }
    }

    /// Transient: shown while the active terminal is scrolled away from its bottom.
    @ViewBuilder
    private var scrollToBottomButton: some View {
        ZStack {
            if let taskID = activeTask?.id, atBottomByTask[taskID] == false {
                Button {
                    TerminalModeRegistry.shared.scrollToBottom(taskID: taskID)
                } label: {
                    Image(systemName: "arrow.down.to.line")
                        .font(Theme.Fonts.label.weight(.semibold))
                        .foregroundStyle(Theme.foreground)
                        .frame(width: 40, height: 40)
                        .background(Theme.card, in: Circle())
                        .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("滚动到底部")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(12)
        .animation(.smooth(duration: 0.2), value: atBottomByTask)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if members.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    createTerminal()
                } label: {
                    Label("新建终端", systemImage: "plus")
                }
            }
        } else if bottomBarItems {
            ToolbarItem(placement: .topBarTrailing) { terminalsMenu }
                .visibilityPriority(.high)
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
                .visibilityPriority(.high)
            ToolbarItem(placement: .bottomBar) { attachMenu }
                .visibilityPriority(.low)
            ToolbarItem(placement: .bottomBar) { keypadButton }
        } else {
            ToolbarItem(placement: .topBarTrailing) { terminalsMenu }
                .visibilityPriority(.high)
            // The laptop pose keeps the full keypad (with 粘贴 and 相册 / 文件) below the fold, so the
            // bar keeps only the terminal list and 更多 (mockup T2).
            if !(layout == .tall && laptopPose) {
                ToolbarItem(placement: .topBarTrailing) { attachMenu }
                    .visibilityPriority(.low)
                ToolbarItem(placement: .topBarTrailing) { keypadButton }
            }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
                .visibilityPriority(.high)
        }
    }

    /// This workspace's terminals with their state, plus 新建终端. The badge counts the other
    /// terminals that wait for the user.
    private var terminalsMenu: some View {
        Menu {
            Picker("终端", selection: activeTaskBinding.animation(.smooth(duration: 0.3))) {
                ForEach(members, id: \.id) { task in
                    Label(terminalMenuTitle(task), systemImage: statusSymbol(task))
                        .tag(Optional(task.id))
                }
            }
            .pickerStyle(.inline)
            Button("新建终端", systemImage: "plus") {
                createTerminal()
            }
        } label: {
            Label("终端", systemImage: "rectangle.stack")
        }
        .badge(otherWaitingCount)
    }

    private var attachMenu: some View {
        Menu {
            Button("相册", systemImage: "photo") { showingPhotoPicker = true }
            Button("文件", systemImage: "folder") { showingFilePicker = true }
        } label: {
            Label("附件", systemImage: "paperclip")
        }
        .disabled(keySender.sessionID == nil || keySender.uploading)
        .accessibilityLabel("上传文件到终端")
    }

    private var keypadButton: some View {
        Button {
            showingKeypad.toggle()
        } label: {
            Label("按键", systemImage: "keyboard")
        }
    }

    private var moreMenu: some View {
        Menu {
            if let task = activeTask {
                if !client.pendingSecretRequests(taskID: task.id).isEmpty {
                    Button("提供 Agent 请求的输入", systemImage: "key") { openSecretSheet() }
                }
                // 复制终端标识（plan 20260914）：曾挂在终端 tab chip 的长按上
                if let handle = EntityHandle.make(.terminal, id: task.id) {
                    Button("复制终端标识", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = handle
                    }
                }
                Button("停止并删除任务", systemImage: "trash", role: .destructive) {
                    confirmingRemove = true
                }
            }
        } label: {
            Label("更多", systemImage: "ellipsis")
        }
    }

    private func terminalMenuTitle(_ task: Coflux_V1_Task) -> String {
        guard let agent = client.agent(forTask: task), !agent.agent.isEmpty else { return taskTitle(task) }
        return "\(taskTitle(task)) · \(agent.agent)"
    }

    private func waits(_ task: Coflux_V1_Task) -> Bool {
        if !client.pendingSecretRequests(taskID: task.id).isEmpty { return true }
        let state = client.agent(forTask: task)?.state
        return state == "approval" || state == "question"
    }

    private var otherWaitingCount: Int {
        members.filter { $0.id != activeTaskID && waits($0) }.count
    }

    /// Shape as well as colour: the menu renders its icons in one tint.
    private func statusSymbol(_ task: Coflux_V1_Task) -> String {
        if waits(task) { return "exclamationmark.bubble.fill" }
        switch task.status {
        case .running: return client.detachedTaskIDs.contains(task.id) ? "eye" : "circle.fill"
        case .exited: return task.exitCode == 0 ? "checkmark.circle" : "xmark.circle"
        default: return "circle"
        }
    }

    private func openSecretSheet() {
        guard let task = activeTask else { return }
        secretSheet = SecretSheetTarget(taskID: task.id)
    }

    // MARK: - Window ownership (plan D12)

    private var unownedTaskIDs: [String] {
        members.map(\.id).filter { ownership.owner(of: $0) == nil }
    }

    private func ownsTerminal(_ taskID: String) -> Bool {
        ownership.isOwned(taskID, by: navigation.sceneID)
    }

    /// Claims every terminal of this page that nobody owns, and `activating` even when another
    /// window owns it.
    private func claimTerminals(activating: String?) {
        for task in members {
            ownership.claim(task.id, scene: navigation.sceneID, holder: claims.id, force: task.id == activating)
        }
    }

    /// Stand-in for a terminal bound in another window; "在这里打开" moves it here.
    private func elsewherePlaceholder(_ task: Coflux_V1_Task) -> some View {
        ContentUnavailableView {
            Label("已在另一个窗口打开", systemImage: "macwindow.on.rectangle")
        } description: {
            Text(taskTitle(task))
        } actions: {
            Button("在这里打开") {
                ownership.claim(task.id, scene: navigation.sceneID, holder: claims.id, force: true)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.primary)
            .foregroundStyle(Theme.primaryForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.terminal)
    }

    // MARK: - 任务页（逐任务保活）

    @ViewBuilder
    private func taskPage(_ task: Coflux_V1_Task) -> some View {
        if !ownsTerminal(task.id) {
            elsewherePlaceholder(task)
        } else {
            TerminalHostView(
                client: client,
                taskID: task.id,
                sessionID: task.hasSessionID ? task.sessionID : nil,
                onSizeChanged: { cols, rows in
                    termCols = cols
                    termRows = rows
                },
                onAtBottomChanged: { atBottomByTask[task.id] = $0 }
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
                .foregroundStyle(Theme.primaryForeground)
        }
        .background(Theme.background)
    }

    private func createTerminal() {
        knownTaskIDsBeforeCreate = Set(members.map(\.id))
        client.createTask(workspaceID: workspace.id, title: "终端 \(members.count + 1)")
    }

    // MARK: - Sending

    private var keySender: TerminalKeySender {
        TerminalKeySender(client: client, task: activeTask)
    }

    private var composerPlaceholder: String {
        guard let task = activeTask, let agent = client.agent(forTask: task), !agent.agent.isEmpty else {
            return "输入命令…"
        }
        return "回复 \(agent.agent)…"
    }

    /// fullScreenCover 默认自下滑入/滑出；成文层要的是背景淡入淡出（内容层自己做 fade），
    /// 故呈现切换一律禁系统动画
    private func setComposing(_ on: Bool) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { composing = on }
    }

    /// 发送的前置条件：任务在跑且有 session。不满足时什么都不发，调用方自己兜底（成文层留驻
    /// 提示「终端未运行」，对讲落地退到草稿，不让话凭空丢）。
    private var terminalReady: Bool {
        guard let task = activeTask else { return false }
        return task.status == .running && task.hasSessionID
    }

    /// Writes `text` (+ Enter) to the active terminal as one input (plan D10): the composer, the
    /// dock's send button and dictation's confirmed send all come through here. Returns whether
    /// anything was sent.
    @discardableResult
    private func sendText(_ text: String, withEnter: Bool) -> Bool {
        guard terminalReady, let task = activeTask,
              let payload = ComposerPayload.bytes(text, withEnter: withEnter) else { return false }
        client.sendInput(sessionID: task.sessionID, payload)
        return true
    }

    private func sendDraft(withEnter: Bool) -> Bool {
        guard sendText(draft, withEnter: withEnter) else { return false }
        draft = ""
        return true
    }

    /// The dock's send button: sends the draft when the terminal is ready; otherwise opens the
    /// compose layer, which keeps the draft and says why nothing went out.
    private func sendFromDock(withEnter: Bool) {
        guard !draft.isEmpty else { return }
        if !sendDraft(withEnter: withEnter) {
            setComposing(true)
        }
    }

    // MARK: - 长按对讲（plan 064 → 066 确认态 → 067 松手直发 → plan 068 复议恢复确认关卡 →
    // plan 069 乐观启动）：composer 长按开始，蒙层上两颗按钮（左取消 / 右发送）。按住期间滑进哪颗，
    // 松手就直接执行哪个；原地松手则进确认态，草稿定格等用户点发送/点文字编辑。转写文字落终端
    // 必经显式确认：coflux 是纯转文字，识别错误没有兜底。

    /// 按下即采音（plan 069）：touch down 去抖后起 session，蒙层不显示。长按判定通过时
    /// beginDictation 直接接管这个 session——不得丢弃重建。未授权时整段跳过：否则首次点一下
    /// composer 想打字就弹麦克风权限框。
    private func prewarmDictation() {
        guard dictationSession == nil, DictationSession.permissionsGranted else { return }
        startDictation()
    }

    /// 长按判定通过：显示蒙层。session 通常已在预热中（复用）；未授权/预热被跳过时此刻才起，
    /// 走完整 start()（含权限请求）。
    private func beginDictation() {
        if dictationSession == nil { startDictation() }
        dictationOverlayVisible = true
    }

    /// 未达长按就松手（plan 069）：静默拆预热 session——麦克风必须在这条路径上释放，否则悬挂
    /// tap 让下次长按静音或崩溃（AudioCapture landmine）。蒙层已显示 = 正常松手分发，不插手。
    private func abortDictation() {
        guard !dictationOverlayVisible, let session = dictationSession else { return }
        dictationSession = nil
        session.cancel()
    }

    private func startDictation() {
        let session = DictationSession()
        dictationSession = session
        dictationZone = .none
        dictationStage = .listening
        session.begin()
    }

    private func closeDictationOverlay() {
        dictationSession = nil
        dictationOverlayVisible = false
        dictationZone = .none
        dictationStage = .listening
    }

    /// 松手分发：按松手瞬间命中的按钮决定去向。
    /// - 取消：立即弃稿拆层，不等终稿；
    /// - 其余：finalizing 短暂留驻等 session.finish() 落定拿终稿（finish() 在松手瞬间就跑，松手
    ///   即释放麦克风；落定前不得拆 session/蒙层，也不得用 volatile 文本抢跑）。终稿到手后：
    ///   滑入发送 → 直接落终端（文字 + 回车）并拆层；原地松手 → 停在确认态；空转写 → 直接拆层；
    ///   权限被拒 / 无字可看的失败留驻示错，失败带字则并入确认态。
    private func endDictation() {
        guard let session = dictationSession else { return }
        let zone = dictationZone
        dictationZone = .none
        if zone == .cancel {
            closeDictationOverlay()
            session.cancel()
            return
        }
        dictationStage = .finalizing
        Task {
            let text = await session.finish()
            guard dictationSession === session else { return }
            dictationStage = .settled
            if text.isEmpty {
                switch session.phase {
                case .permissionDenied, .failed:
                    return  // 留驻示错/引导，点任意处关闭
                default:
                    closeDictationOverlay()  // 空转写：无字可落
                }
                return
            }
            if zone == .send {
                closeDictationOverlay()
                deliver(text)
            }
            // zone == .none：停在确认态，等用户点发送 / 点草稿编辑 / 点取消
        }
    }

    /// 确认态点「发送」：终稿已落定，直接取当前文本落地。
    private func sendDictation() {
        guard let session = dictationSession else { return }
        let text = session.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
        closeDictationOverlay()
        deliver(text)
    }

    /// 确认态点草稿文字：落 draft 开成文层继续编辑。
    private func editDictation() {
        guard let session = dictationSession else { return }
        let text = session.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
        closeDictationOverlay()
        draft = text
        setComposing(true)
    }

    /// 对讲成稿落地：走与成文层同一条「文字 + 回车」路径；落不下去（任务已退出/无 session）
    /// 退到草稿，用户的话不能凭空消失。
    private func deliver(_ text: String) {
        guard !text.isEmpty else { return }
        if !sendText(text, withEnter: true) {
            draft = text
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
