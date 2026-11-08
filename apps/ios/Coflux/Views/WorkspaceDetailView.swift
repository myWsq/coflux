import CofluxClientCore
import CofluxProtocol
import SwiftUI
import UIKit

/// The terminal page (plan 049 → Duo redesign, plan D3/D13/D16): the active terminal fills the
/// content area down to the resting dock; every terminal of the workspace stays mounted in a
/// horizontal pager (swipe to switch, each attached and kept alive; leaving the page unmounts
/// them). A cluster of round avatars in the terminal's top-right corner switches between them
/// (tap one, or swipe the pager; tap the active one for the list with names and states). The
/// title names the active terminal (project · branch · device below); the toolbar carries 新建终端 and
/// 更多, plus 附件 and 粘贴 on the rail's lower end — inside 更多 elsewhere. Status banners float
/// over the terminal's bottom rows.
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
    /// 成文层叠在页面之上、随系统键盘升起：底下的终端与 dock 完全冻结不动
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
    /// The dock's resting height (handle + key row, never the notice bar or the keypad): the
    /// terminal ends above it, so neither the notice bar nor the keyboard resizes the terminal (D13).
    @State private var restingDockHeight: CGFloat = 0
    /// The page's content size: decides the short-window fold and where the toolbar items go.
    @State private var pageSize: CGSize = .zero
    /// The page's size pinned while the compose layer is up (see `base`).
    @State private var frozenPageSize: CGSize?

    /// The size the page lays out at: pinned while composing, otherwise the live one.
    private var laidOutSize: CGSize { frozenPageSize ?? pageSize }
    /// The keypad as a sheet (short windows only).
    @State private var showingKeypad = false
    /// The full keypad pulled out below the key row: how much of it shows (follows the finger,
    /// then animates open or shut). The terminal never resizes for it — it is pushed up by the
    /// same amount, so its bottom rows (where agents and prompts live) stay just above the keypad
    /// and the PTY is never reflowed (user's call, 2026-11-08: no resize after the drag). The
    /// price: the top rows of a top-anchored screen (a fresh shell, vim) sit out of view while the
    /// keypad is open.
    @State private var keypadHeight: CGFloat = 0
    @State private var keypadReveal: CGFloat = 0
    /// keypadReveal when the current drag began; nil while no drag runs.
    @State private var keypadDragStart: CGFloat?
    /// The drag's translation when it was recognised: movement is measured from there.
    @State private var keypadDragAnchor: CGFloat = 0
    /// The terminal's size as laid out, and the size it is pinned to while composing.
    @State private var liveTerminalSize: CGSize = .zero
    @State private var frozenTerminalSize: CGSize?
    @State private var showingPhotoPicker = false
    @State private var showingFilePicker = false
    @State private var secretSheet: SecretSheetTarget?
    /// Tall layout, half folded with a horizontal fold: the keypad is inline below the fold and
    /// the 按键 toolbar item goes away (plan D9).
    @State private var laptopPose = false
    /// The list of every terminal, opened from the active avatar.
    @State private var showingTerminalList = false

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
        layout != .tall && laidOutSize.height > 0 && laidOutSize.height < Self.shortPageHeight
    }

    /// 附件 / 按键 go to the bottom bar (the lower end of the rail on the outer display and in the
    /// split detail) unless the window lays its bars out horizontally and short: then everything
    /// stays in the top bar, as in the tall layout.
    private var bottomBarItems: Bool {
        barsOnRail
    }

    /// The system draws this page's bars as a vertical rail (the outer display, a Split View half,
    /// the split detail column): every window that is not the tall layout and not wider than tall.
    private var barsOnRail: Bool {
        layout != .tall && laidOutSize.height >= laidOutSize.width
    }

    /// The avatars' diameter: the outer display and the other compact windows, the tall layout.
    private var avatarSize: CGFloat {
        layout == .tall ? 34 : 30
    }

    // MARK: - Titles

    /// A directory workspace (no repository) is the device's terminal: the device names the page.
    /// 「目录工作区由设备命名」是工作区种类的属性而不是调用方偏好，故在此解析。
    private var deviceLabel: String {
        client.deviceName(workspace.daemonID)
    }

    /// What the terminal is doing (its title, as on the desktop tab), else its agent, else its
    /// own name.
    private func terminalName(_ task: Coflux_V1_Task) -> String {
        if let title = client.terminalTitle(forTask: task) { return title }
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

    /// project · branch · device; the terminal for a directory workspace (the title is the
    /// device).
    private var subtitleText: String {
        if isDirWorkspace(workspace) { return activeTask.map(terminalName) ?? "" }
        let project = client.projects.first { $0.id == workspace.projectID }?.name ?? ""
        return [project, workspace.displayTitle, deviceLabel].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func taskTitle(_ task: Coflux_V1_Task) -> String {
        task.title.isEmpty ? "终端 \(task.id.prefix(6))" : task.title
    }

    // MARK: - Body

    var body: some View {
        // The compose layer sits in the same view tree, over the page: presenting it as a
        // fullScreenCover took the toolbar off the rail and re-laid the page out in another
        // container (the terminal jumped 522 → 761 pt and back, seen in the Duo's log). The page
        // ignores the keyboard (frozen base, 2026-07-26); the layer above it rides on it.
        ZStack {
            base
            if composing {
                TerminalComposeOverlay(
                    draft: $draft,
                    ready: terminalReady,
                    placeholder: composerPlaceholder,
                    onSend: { sendDraft() },
                    onPhoto: { data, type in keySender.uploadImage(data: data, typeIdentifier: type, prefix: "photo") },
                    onDismiss: { setComposing(false) }
                )
            }
        }
        // Nothing on this page follows the keyboard; the compose layer lifts its card itself.
        .ignoresSafeArea(.keyboard)
        .navigationTitle(titleText)
        .navigationSubtitle(subtitleText)
        .navigationBarTitleDisplayMode(.inline)
        // The page draws its title itself, always on the leading side (mockup
        // `wiki/plans/20261108-ios-terminal-facepile-mockup.html`, user's call 2026-11-08): the
        // system's inline title centres a short name and moves a long one to the side, and on
        // the rail it takes ~80 pt for one line. The navigation title stays for the back menu.
        .toolbar(removing: .title)
        // The bottom of the rail belongs to this page's toolbar, not the tab bar.
        .toolbar(.hidden, for: .tabBar)
        .toolbar { toolbarContent }
    }

    /// The page itself, immune to the system keyboard, with its sheets and lifecycle hooks.
    private var base: some View {
        pageContent
            // Pinned, top-aligned, while the compose layer is up: with the keyboard showing the
            // page's frame grows past the screen (620 → 797 pt on the outer display, seen in the
            // Duo's log) and everything bottom-aligned slid away under the keyboard.
            .frame(width: frozenPageSize?.width, height: frozenPageSize?.height)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.terminal)
            // 基座对系统键盘免疫（冻结）：键盘只属于叠在上面的成文层
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
            .sheet(isPresented: $showingKeypad) {
                TerminalExtraKeys(client: client, task: activeTask)
                    .padding(.horizontal, 16)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
                    // A short window's extra keys: a low panel that leaves the terminal and the
                    // quick rows usable and stays open while keys are pressed.
                    .presentationDetents([.height(150)])
                    .presentationBackgroundInteraction(.enabled(upThrough: .height(150)))
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
            .confirmationDialog("删除终端？", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("停止并删除", role: .destructive) {
                    if let task = activeTask {
                        Task { await client.closeTask(task) }
                    }
                }
            } message: {
                Text("正在运行的会话会被停止，终端将从列表中移除")
            }
            .onAppear {
                if activeTaskID == nil || !members.contains(where: { $0.id == activeTaskID }) {
                    activeTaskID = members.first?.id
                }
                claims.attach(ownership)
                claimTerminals(activating: activeTaskID)
            }
            // An open keypad whose height changed (a wider window adds ← →): follow it.
            .onChange(of: keypadHeight) { old, height in
                guard keypadDragStart == nil, old > 0, keypadReveal == old else { return }
                keypadReveal = height
            }
            // Activating a terminal (swipe, list, card, sidebar) takes it from another window.
            .onChange(of: activeTaskID) { _, id in
                claimTerminals(activating: id)
            }
            .onChange(of: activeTaskID, initial: true) { _, _ in updateSeenFinished() }
            .onChange(of: finishedTaskIDs) { _, _ in updateSeenFinished() }
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
            VStack(spacing: 0) {
                // With the bars on the rail the title row is the page's own: the name on the
                // left, the avatars on the right.
                if barsOnRail {
                    HStack(spacing: 12) {
                        pageTitle
                        Spacer(minLength: 0)
                        terminalAvatars
                    }
                    .padding(.leading, 14)
                    .padding(.trailing, 10)
                    .frame(height: 44)
                    .padding(.top, 6)
                    .background(Theme.terminal)
                    .zIndex(1)
                }
                ZStack(alignment: .bottom) {
                    terminalColumn(reserveDock: true)
                    dock(inlineKeypad: false)
                }
                // The keypad pushes the terminal up past the title row: clip it there.
                .clipped()
            }
            // With the bars on the rail nothing is drawn across the top or the bottom (status,
            // camera and home indicator sit on the rail), yet the safe area keeps ~30 pt at each:
            // the title row and the keys take them.
            .ignoresSafeArea(.container, edges: barsOnRail ? .vertical : [])
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
                    .clipped()
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

    /// The terminals of this workspace as a cluster of round avatars floating over the
    /// terminal's top-right corner (mockup F4, `wiki/plans/20261108-ios-terminal-facepile-mockup.html`;
    /// the user's design, 2026-11-08). They overlap like a facepile, each earlier one over the
    /// next; the active one stays in the pile, raised above its neighbours, with a white ring. The dot at
    /// each one's bottom right is its state, in the home rows' tones. No pad behind them: each avatar
    /// carries its own shadow. A tap on another avatar switches to it (the pager follows; a
    /// swipe of the pager switches too); a tap on the active one opens the list with every
    /// terminal's name and state, and 新建终端.
    private var terminalAvatars: some View {
        let tasks = members
        let activeIndex = tasks.firstIndex { $0.id == activeTaskID }
        return HStack(spacing: -Self.avatarOverlap) {
            ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                let active = index == activeIndex
                Button {
                    if active {
                        withAnimation(.smooth(duration: 0.2)) { showingTerminalList.toggle() }
                    } else {
                        showingTerminalList = false
                        withAnimation(.smooth(duration: 0.25)) { activeTaskID = task.id }
                    }
                } label: {
                    terminalAvatar(task, active: active)
                }
                .buttonStyle(.plain)
                .zIndex(active ? Double(tasks.count + 1) : Double(tasks.count - index))
                .accessibilityLabel(tabName(task))
                .accessibilityValue(TerminalActivity(task, client: client).text)
                .accessibilityHint(active ? "显示全部终端" : "切换到这个终端")
                .accessibilityAddTraits(active ? .isSelected : [])
            }
        }
        .animation(.smooth(duration: 0.25), value: activeTaskID)
    }

    private static let avatarOverlap: CGFloat = 10

    /// A round avatar: the agent's mark, a white ring on the active terminal (faint on the
    /// others), and a dot at the bottom right in the state's tone (user's call, 2026-11-08).
    private func terminalAvatar(_ task: Coflux_V1_Task, active: Bool, size: CGFloat? = nil) -> some View {
        let size = size ?? avatarSize
        let activity = TerminalActivity(task, client: client)
        let ring = active ? Theme.foreground : Theme.foreground.opacity(0.16)
        return Circle()
            .fill(Theme.card)
            .frame(width: size, height: size)
            .overlay { avatarGlyph(task, size: size * 0.58) }
            .overlay(Circle().strokeBorder(ring, lineWidth: 2))
            // Overlapping avatars stay apart: a ring of the terminal's colour around each.
            .background(Circle().fill(Theme.terminal).padding(-2))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(activity.tone.color)
                    .frame(width: size * 0.3, height: size * 0.3)
                    .overlay(Circle().strokeBorder(Theme.terminal, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
            .compositingGroup()
            .shadow(color: .black.opacity(0.6), radius: 4, y: 3)
            .contentShape(Circle())
    }

    /// The agent's mark: Clawd for claude (its state's pose, the error cross when it stopped on
    /// an error), >_ for codex, an initial for another agent, the terminal symbol for a shell.
    @ViewBuilder
    private func avatarGlyph(_ task: Coflux_V1_Task, size: CGFloat) -> some View {
        let agent = task.status == .running ? client.agent(forTask: task) : nil
        switch agent?.agent.lowercased() {
        case "claude":
            if agent?.state == "error" {
                Image(systemName: "xmark")
                    .font(.system(size: size * 0.7, weight: .bold))
                    .foregroundStyle(Theme.destructive)
            } else {
                ClawdGlyph(
                    pose: ClawdPose(state: agent?.state ?? "", seen: navigation.seenFinishedTaskIDs.contains(task.id)),
                    size: min(size, ClawdSheet.renderedGlyphSize)
                )
            }
        case "codex":
            Text(">_")
                .font(.system(size: size * 0.62, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.foreground)
        case .some(let name) where !name.isEmpty:
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.72, weight: .bold))
                .foregroundStyle(Theme.foreground)
        default:
            Image(systemName: "terminal")
                .font(.system(size: size * 0.6, weight: .semibold))
                .foregroundStyle(Theme.mutedForeground)
        }
    }

    /// Every terminal with its name and state line (the home rows' tones), the active one
    /// checked, then 新建终端. Scrolls when the terminals outgrow the page.
    private var terminalList: some View {
        let rows = VStack(spacing: 2) {
            ForEach(members, id: \.id) { task in
                terminalListRow(task)
            }
            Rectangle()
                .fill(Theme.border)
                .frame(height: 1)
                .padding(.vertical, 4)
            Button {
                showingTerminalList = false
                createTerminal()
            } label: {
                Label("新建终端", systemImage: "plus")
                    .font(Theme.Fonts.rowTitle)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(6)
        return ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }
                .scrollIndicators(.hidden)
        }
        .frame(width: min(320, max(240, laidOutSize.width - 32)))
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.foreground.opacity(0.09), lineWidth: 1))
        .shadow(color: .black.opacity(0.55), radius: 18, y: 10)
    }

    private func terminalListRow(_ task: Coflux_V1_Task) -> some View {
        let active = task.id == activeTaskID
        let activity = TerminalActivity(task, client: client)
        return Button {
            showingTerminalList = false
            withAnimation(.smooth(duration: 0.25)) { activeTaskID = task.id }
        } label: {
            HStack(spacing: 10) {
                terminalAvatar(task, active: false, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(tabName(task))
                        .font(Theme.Fonts.rowTitle)
                        .foregroundStyle(Theme.foreground)
                    Text(activity.text)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(activity.tone.color)
                }
                .lineLimit(1)
                Spacer(minLength: 4)
                if active {
                    Image(systemName: "checkmark")
                        .font(Theme.Fonts.label.weight(.bold))
                        .foregroundStyle(Theme.foreground)
                }
            }
            .padding(8)
            .background(active ? Theme.accentSurface : .clear, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Finished turns the user has looked at

    /// Terminals whose agent finished its turn: they throw confetti until the user looks at them.
    private var finishedTaskIDs: [String] {
        members.filter { task in
            let state = client.agent(forTask: task)?.state
            return state == "done" || state == "waiting"
        }.map(\.id)
    }

    /// A finished terminal counts as seen once it is the active one (the shell forgets it when
    /// its agent starts another turn).
    private func updateSeenFinished() {
        guard let active = activeTaskID, finishedTaskIDs.contains(active),
              !navigation.seenFinishedTaskIDs.contains(active) else { return }
        navigation.seenFinishedTaskIDs.insert(active)
    }

    /// The agent's name, or the terminal's title when another terminal here shows the same name.
    private func tabName(_ task: Coflux_V1_Task) -> String {
        let name = terminalName(task)
        let clash = members.contains { $0.id != task.id && terminalName($0) == name }
        return clash ? taskTitle(task) : name
    }

    /// Status strip + the pager. With `reserveDock` the terminal ends above the resting dock and
    /// rides up with the keypad.
    private func terminalColumn(reserveDock: Bool) -> some View {
        pager
            // Floating over the terminal's bottom rows, never below them: a banner that comes and
            // goes (another device takes over, the session exits) must not resize the terminal.
            // It sits at the bottom, under the scroll-to-bottom button, to leave the top-right
            // corner to the avatars.
            .overlay(alignment: .bottom) {
                VStack(alignment: .trailing, spacing: 0) {
                    scrollToBottomButton
                    if let task = activeTask {
                        statusStrip(task)
                    }
                }
            }
            .overlay(alignment: .topTrailing) {
                ZStack(alignment: .topTrailing) {
                    // A tap anywhere else closes the list.
                    if showingTerminalList {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(.smooth(duration: 0.2)) { showingTerminalList = false }
                            }
                    }
                    VStack(alignment: .trailing, spacing: 8) {
                        // On the rail the avatars sit in the title row; the list still drops
                        // down over the terminal's corner.
                        if !barsOnRail {
                            terminalAvatars
                        }
                        if showingTerminalList {
                            terminalList
                                .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topTrailing)))
                        }
                    }
                    .padding(.top, barsOnRail ? 6 : 10)
                    .padding(.trailing, 10)
                }
            }
            .padding(.bottom, reserveDock ? restingDockHeight : 0)
        .offset(y: reserveDock ? -keypadReveal : 0)
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
            inlineKeypad: inlineKeypad,
            bottomGap: barsOnRail ? TerminalInputArea.railBottomGap : 8,
            keypadReveal: inlineKeypad ? 0 : keypadReveal,
            onKeypadHeight: { keypadHeight = $0 },
            onRestingHeight: { height in
                if !inlineKeypad { restingDockHeight = height }
            },
            onKeypadDrag: { keypadDragChanged($0) },
            onKeypadDragEnd: { keypadDragEnded($0) },
            onKeypadToggle: { toggleKeypad() },
            onOpenSecret: { openSecretSheet() },
            onCompose: {
                guard !dictationOverlayVisible else { return }
                setComposing(true)
            },
            onDictatePrewarm: { prewarmDictation() },
            onDictateBegin: { beginDictation() },
            onDictateMove: { dictationZone = DictationZone.hit($0, in: dictationBounds) },
            onDictateEnd: { endDictation() },
            onDictateAbort: { abortDictation() }
        )
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

    /// The page's title: the active terminal, and project · branch · device below it, on the
    /// leading side. The rail's title row holds it; otherwise the top bar's leading slot.
    private var pageTitle: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(titleText)
                .font(Theme.Fonts.rowTitle)
                .foregroundStyle(Theme.foreground)
            if !subtitleText.isEmpty {
                Text(subtitleText)
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.mutedForeground)
            }
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if !barsOnRail {
            // Room left by the back button, two trailing items and the status bar's corner.
            ToolbarItem(placement: .topBarLeading) {
                pageTitle
                    .frame(maxWidth: max(140, laidOutSize.width - 330), alignment: .leading)
            }
            .sharedBackgroundVisibility(.hidden)
        }
        if members.isEmpty {
            ToolbarItem(placement: .topBarTrailing) { newTerminalButton }
        } else if bottomBarItems {
            // The avatars list and switch the terminals, so the rail only adds one.
            ToolbarItem(placement: .topBarTrailing) { newTerminalButton }
                .visibilityPriority(.high)
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
                .visibilityPriority(.high)
            ToolbarItem(placement: .bottomBar) { attachMenu }
                .visibilityPriority(.low)
            ToolbarItem(placement: .bottomBar) { pasteButton }
        } else {
            // One 更多 holds 粘贴 and 附件 too: a top bar that runs out of room folds items into
            // the system's own overflow menu, which put 更多 inside another 更多.
            ToolbarItem(placement: .topBarTrailing) { newTerminalButton }
                .visibilityPriority(.high)
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
                .visibilityPriority(.high)
        }
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

    /// 粘贴: plan 071's behaviour — an image on the clipboard is uploaded, text is pasted.
    private var pasteButton: some View {
        Button {
            keySender.paste()
        } label: {
            Label("粘贴", systemImage: "doc.on.clipboard")
        }
        .disabled(keySender.sessionID == nil || keySender.uploading)
    }

    private var newTerminalButton: some View {
        Button {
            createTerminal()
        } label: {
            Label("新建终端", systemImage: "plus")
        }
    }

    // MARK: - Pulling the keypad out

    /// The finger moved: the keys follow it 1:1 from where the drag was recognised (no jump by
    /// the gesture's minimum distance), and past either end they give with a rubber band.
    private func keypadDragChanged(_ translation: CGFloat) {
        // While talking the finger slides over the dock onto 发送 / 取消: not a keypad drag.
        if dictationOverlayVisible {
            if keypadDragStart != nil { setKeypad(open: keypadReveal > keypadHeight / 2) }
            return
        }
        guard !shortWindow, keypadHeight > 0 else { return }
        if keypadDragStart == nil {
            keypadDragStart = keypadReveal
            keypadDragAnchor = translation
        }
        let raw = (keypadDragStart ?? 0) - (translation - keypadDragAnchor)
        keypadReveal = Self.rubberBand(raw, limit: keypadHeight)
    }

    /// Inside 0…limit unchanged; beyond it the excess is damped like UIScrollView's bounce. Below
    /// 0 the keys cannot shrink further, so the overshoot is simply held at 0.
    private static func rubberBand(_ value: CGFloat, limit: CGFloat) -> CGFloat {
        if value <= 0 { return 0 }
        guard value > limit else { return value }
        let excess = value - limit
        let dimension: CGFloat = 120
        return limit + (1 - 1 / (excess * 0.55 / dimension + 1)) * dimension
    }

    /// Released: a clear flick or pull settles in its direction, however short (a small swipe down
    /// must collapse — needing half the keypad's height made it feel ignored); a hesitant release
    /// settles by where the keypad is. A short window has no room below the terminal, so an
    /// upward flick opens the keypad as a sheet there.
    private func keypadDragEnded(_ predictedTranslation: CGFloat) {
        if shortWindow {
            if predictedTranslation < -24, !dictationOverlayVisible { showingKeypad = true }
            return
        }
        guard keypadDragStart != nil else { return }
        keypadDragStart = nil
        let open: Bool
        if predictedTranslation < -24 {
            open = true
        } else if predictedTranslation > 24 {
            open = false
        } else {
            open = keypadReveal > keypadHeight / 2
        }
        setKeypad(open: open)
    }

    /// The handle's tap.
    private func toggleKeypad() {
        if shortWindow {
            showingKeypad = true
        } else {
            setKeypad(open: keypadReveal < keypadHeight / 2)
        }
    }

    /// Animates the keypad open or shut with a little spring; the terminal rides along.
    private func setKeypad(open: Bool) {
        keypadDragStart = nil
        withAnimation(.spring(response: 0.36, dampingFraction: 0.78)) {
            keypadReveal = open ? keypadHeight : 0
        }
    }

    private var moreMenu: some View {
        Menu {
            if !bottomBarItems {
                Section {
                    Button("粘贴", systemImage: "doc.on.clipboard") { keySender.paste() }
                    Button("从相册上传", systemImage: "photo") { showingPhotoPicker = true }
                    Button("上传文件", systemImage: "folder") { showingFilePicker = true }
                }
                .disabled(keySender.sessionID == nil || keySender.uploading)
            }
            if let task = activeTask {
                if !client.pendingSecretRequests(taskID: task.id).isEmpty {
                    Button("提供 Agent 请求的输入", systemImage: "key") { openSecretSheet() }
                }
                // 复制终端标识（plan 20260914）：曾挂在终端 tab chip 的长按上
                if let handle = EntityHandle.make(.terminal, id: task.id) {
                    Button("复制终端 ID", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = handle
                    }
                }
                Button("停止并删除终端", systemImage: "trash", role: .destructive) {
                    confirmingRemove = true
                }
            }
        } label: {
            Label("更多", systemImage: "ellipsis")
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
            Button("在此窗口打开") {
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
            // Pinned while the compose layer is up: whatever the page does under the keyboard,
            // the terminal keeps its size, so it never reflows for typing.
            .frame(width: frozenTerminalSize?.width, height: frozenTerminalSize?.height)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .clipped()
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                if !composing { liveTerminalSize = size }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label {
                Text("暂无终端")
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

    /// 成文层自己做淡入淡出，挂载/拆除不带系统过渡
    private func setComposing(_ on: Bool) {
        if on, liveTerminalSize.width > 0 { frozenTerminalSize = liveTerminalSize }
        if on, pageSize.width > 0 { frozenPageSize = pageSize }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { composing = on }
        if !on {
            // Let go once the keyboard is down and the page is back to its size.
            Task {
                try? await Task.sleep(for: .milliseconds(450))
                if !composing {
                    frozenTerminalSize = nil
                    frozenPageSize = nil
                }
            }
        }
    }

    /// 发送的前置条件：任务在跑且有 session。不满足时什么都不发，调用方自己兜底（成文层留驻
    /// 提示「终端未运行」，对讲落地退到草稿，不让话凭空丢）。
    private var terminalReady: Bool {
        guard let task = activeTask else { return false }
        return task.status == .running && task.hasSessionID
    }

    /// Writes `text` to the active terminal as one input, without Enter — the user presses Enter
    /// themselves (2026-11-08). The compose layer and dictation's send both come through here.
    /// Returns whether anything was sent.
    @discardableResult
    private func sendText(_ text: String) -> Bool {
        guard terminalReady, let task = activeTask,
              let payload = ComposerPayload.bytes(text, withEnter: false) else { return false }
        client.sendInput(sessionID: task.sessionID, payload)
        return true
    }

    private func sendDraft() -> Bool {
        guard sendText(draft) else { return false }
        draft = ""
        return true
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

    /// 对讲成稿落地：走与成文层同一条「只发文字」路径；落不下去（任务已退出/无 session）
    /// 退到草稿，用户的话不能凭空消失。
    private func deliver(_ text: String) {
        guard !text.isEmpty else { return }
        if !sendText(text) {
            draft = text
        }
    }

    // MARK: - 逐任务横幅（语义同 plan 046：接管/可启动/输入缓冲满）

    @ViewBuilder
    private func statusStrip(_ task: Coflux_V1_Task) -> some View {
        if client.detachedTaskIDs.contains(task.id) {
            banner(
                text: "此终端正在其他设备上使用",
                icon: "eye",
                tint: Theme.warning,
                actionLabel: "在此使用"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows, force: true)
            }
        } else if task.status != .running {
            banner(
                text: task.status == .exited ? "会话已退出" : "终端尚未启动",
                icon: "play.circle",
                tint: Theme.mutedForeground,
                actionLabel: "启动"
            ) {
                client.startTask(taskID: task.id, cols: termCols, rows: termRows)
            }
        } else if task.hasSessionID, client.blockedSessionIDs.contains(task.sessionID) {
            banner(text: "输入过多，正在等待终端处理", icon: "hourglass", tint: Theme.warning, actionLabel: nil, action: nil)
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
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 7)
        // Floats over terminal text: an opaque card, tinted.
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }
}
