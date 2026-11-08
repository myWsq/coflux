import CofluxClientCore
import CofluxProtocol
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The bytes a composed text sends (plan D10): line breaks — which only paste or dictation can
/// bring in — are flattened to spaces at the trust boundary, and Enter is appended unless the user
/// long-pressed send. Never wrapped in bracketed paste: that depends on the receiver's mode 2004,
/// and the text must land the same way in every program. nil = nothing to send.
enum ComposerPayload {
    static func bytes(_ text: String, withEnter: Bool) -> String? {
        guard !text.isEmpty else { return nil }
        let flat = text.components(separatedBy: .newlines).joined(separator: " ")
        return withEnter ? flat + "\r" : flat
    }
}

/// Sends keys and uploads to the active terminal's session. Shared by the dock's key row and the
/// full keypad, so every key sends exactly what the old control pad sent.
@MainActor
struct TerminalKeySender {
    let client: CofluxClient
    let task: Coflux_V1_Task?

    /// The running session keys go to; nil disables the keys.
    var sessionID: String? {
        guard let task, task.status == .running, task.hasSessionID else { return nil }
        return task.sessionID
    }

    /// 上传忙态（plan 071）：相册/文件/粘贴三个入口共享——同一 session 同刻只有一次上传在途
    /// （CofluxClient.uploadFile 自身也有此门控，这里只管 UI 呈现）。
    var uploading: Bool {
        sessionID.map { client.uploadingSessionIDs.contains($0) } ?? false
    }

    func press(_ bytes: String) {
        guard let sessionID else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        client.sendInput(sessionID: sessionID, bytes)
    }

    /// 方向键按下时查激活终端的 DECCKM：应用模式发 SS3（ESC O），否则 CSI（ESC [）。
    /// The registry is owner-guarded, so after a terminal moves between windows this reads the
    /// mode of the view that owns it now.
    func arrowBytes(_ letter: String) -> String {
        let application = task.map { TerminalModeRegistry.shared.applicationCursor(taskID: $0.id) } ?? false
        return (application ? "\u{1b}O" : "\u{1b}[") + letter
    }

    /// 粘贴：剪贴板有图先走上传（plan 071），否则回落系统剪贴板文本直发终端；剪贴板天然可能
    /// 多行，包 bracketed paste 防换行在开 2004 的接收端被当提交。
    func paste() {
        if let (data, typeIdentifier) = clipboardImageData() {
            uploadImage(data: data, typeIdentifier: typeIdentifier, prefix: "paste")
            return
        }
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        press("\u{1b}[200~" + text + "\u{1b}[201~")
    }

    /// 剪贴板原始图片字节（plan 071 landmine）：UIPasteboard.image 返回的是系统重新解码的
    /// UIImage，会丢原始字节；data(forPasteboardType:) 才是未经改动的原始数据，只在超预算时
    /// 才允许重编码。
    private func clipboardImageData() -> (Data, String)? {
        let pasteboard = UIPasteboard.general
        for uti in [UTType.png.identifier, UTType.jpeg.identifier, UTType.heic.identifier] {
            if let data = pasteboard.data(forPasteboardType: uti), !data.isEmpty {
                return (data, uti)
            }
        }
        return nil
    }

    /// 图片上传编排（plan 071）：ImagePipeline.process 是 nonisolated async——await 时真正跑在
    /// 后台线程，大图解码/重编码不占用 MainActor。命名单段 `<前缀>-<epoch毫秒>-<短随机><ext>`
    /// （temp 模式 path 只认单段文件名，device.proto:453 注释）。
    func uploadImage(data: Data, typeIdentifier: String?, prefix: String) {
        guard let sessionID else { return }
        let client = self.client
        Task {
            guard let (payload, ext) = await ImagePipeline.process(data: data, typeIdentifier: typeIdentifier) else {
                client.reportLocalError("图片处理失败")
                return
            }
            await client.uploadFile(
                sessionID: sessionID, data: payload, suggestedName: Self.uploadName(prefix: prefix, ext: ext)
            )
        }
    }

    /// 文件上传编排（plan 071）：asCopy 拿到的沙盒拷贝直接读字节，原文件名只取安全扩展名。
    /// 超上限由 CofluxClient.uploadFile→DeviceRouter.fsWrite 前置拦截并报错，这里不重复判断。
    /// ponytail: Data(contentsOf:) 在 MainActor 上同步读（asCopy 沙盒拷贝，上限 30MB）；
    /// 若真机测出卡顿再挪后台线程。
    func uploadFile(url: URL) {
        guard let sessionID else { return }
        let client = self.client
        Task {
            guard let data = try? Data(contentsOf: url) else {
                client.reportLocalError("读取文件失败")
                return
            }
            let name = Self.uploadName(prefix: "file", ext: Self.safeExtension(url.lastPathComponent))
            await client.uploadFile(sessionID: sessionID, data: data, suggestedName: name)
        }
    }

    /// 单段上传文件名（plan 071 命名规则）：<前缀>-<epoch毫秒>-<短随机><ext>（ext 含前导点，可为空）。
    private static func uploadName(prefix: String, ext: String) -> String {
        let suffix = String((0 ..< 6).compactMap { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement() })
        return "\(prefix)-\(Int(Date().timeIntervalSince1970 * 1000))-\(suffix)\(ext)"
    }

    /// web safeDropExtension 同原则：只保留 ASCII 字母数字扩展名（1-16 字符），否则丢扩展名。
    private static func safeExtension(_ filename: String) -> String {
        guard let dotIndex = filename.lastIndex(of: "."), dotIndex != filename.startIndex else { return "" }
        let ext = filename[filename.index(after: dotIndex)...]
        guard (1 ... 16).contains(ext.count), ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return ""
        }
        return ".\(ext)"
    }
}

// MARK: - Key caps

/// How a key cap is drawn.
enum KeyStyle {
    case normal
    /// ^C: destructive text
    case destructive
    /// Option digits while an agent waits: amber fill
    case hot
    /// ⏎: inverted primary
    case enter
}

/// A key cap: mockup 40 pt high (46 enlarged), radius 13, glass-like input fill.
struct KeyCap: View {
    var label: String?
    var systemImage: String?
    var style: KeyStyle = .normal
    var height: CGFloat = Theme.Metrics.keyHeight
    var large = false

    var body: some View {
        Group {
            if let systemImage {
                Image(systemName: systemImage)
            } else {
                Text(label ?? "")
            }
        }
        .font(large ? Theme.Fonts.keyLarge : Theme.Fonts.key)
        .foregroundStyle(foreground)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(background, in: RoundedRectangle(cornerRadius: Theme.Metrics.keyRadius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Metrics.keyRadius)
                .strokeBorder(stroke, lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: Theme.Metrics.keyRadius))
    }

    private var foreground: Color {
        switch style {
        case .normal: Theme.foreground
        case .destructive: Theme.destructive
        case .hot: Theme.warning
        case .enter: Theme.primaryForeground
        }
    }

    private var background: Color {
        switch style {
        case .normal, .destructive: Theme.input
        case .hot: Theme.warning.opacity(0.16)
        case .enter: Theme.primary
        }
    }

    private var stroke: Color {
        switch style {
        case .normal, .destructive: Theme.border
        case .hot: Theme.warning.opacity(0.35)
        case .enter: .clear
        }
    }
}

/// Dims a pressed key a little: keys react without any custom timing.
struct KeyPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

/// A key that sends its bytes once per tap.
struct TerminalKey: View {
    let sender: TerminalKeySender
    var label: String?
    var systemImage: String?
    var style: KeyStyle = .normal
    var height: CGFloat = Theme.Metrics.keyHeight
    var large = false
    let bytes: () -> String

    var body: some View {
        Button {
            sender.press(bytes())
        } label: {
            KeyCap(label: label, systemImage: systemImage, style: style, height: height, large: large)
        }
        .buttonStyle(KeyPressStyle())
    }
}

/// 可连发键（方向/退格）：按下即发一次（实体键盘语义），按住 0.35s 后以 80ms 间隔连发，松手停。
struct RepeatKey: View {
    let sender: TerminalKeySender
    var label: String?
    var systemImage: String?
    var height: CGFloat = Theme.Metrics.keyHeight
    var large = false
    let bytes: () -> String
    @State private var timer: Timer?

    var body: some View {
        KeyCap(label: label, systemImage: systemImage, height: height, large: large)
            .onLongPressGesture(minimumDuration: 0.35, maximumDistance: 40) {
                guard let sessionID = sender.sessionID else { return }
                // 连发期间序列求值一次即可（按住途中 DECCKM 不会切换）；只捕获 Sendable 值跨进 Timer 闭包
                let payload = bytes()
                let client = sender.client
                timer?.invalidate()
                timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
                    Task { @MainActor in client.sendInput(sessionID: sessionID, payload) }
                }
            } onPressingChanged: { pressing in
                if pressing {
                    sender.press(bytes())
                } else {
                    stop()
                }
            }
            .onDisappear { stop() }
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
    }
}

// MARK: - The dock

/// The terminal page's dock: an optional notice bar over a key row that follows the agent, pinned
/// to the bottom of the content area. Typing lives on the 输入 toolbar item; talking on the
/// row's microphone key (hold).
///
/// - Key row: when the active terminal's agent is in `approval` or `question` it becomes the
///   enlarged option keys `1 2 3 🎤 ↑ ↓ ⏎` (only the keys' bytes are sent — the menu text is never
///   parsed); otherwise `esc ^C tab 🎤 ↑ ↓ /`, plus `← →` when the dock is wide enough.
/// - Extra keys: a swipe up anywhere over the dock brings the keys the quick rows leave out
///   (`TerminalExtraKeys`) up above the quick rows, following the finger; the host owns how much
///   shows (`keypadReveal`), snaps it open or shut on release, and pushes the terminal up by the
///   same amount. A swipe down puts them away.
/// - The row has one fixed height, and the notice bar floats above the dock outside its measured
///   size, so the notice never changes the terminal's size.
/// - Laptop pose: `inlineKeypad` shows the quick rows and the extra keys below the fold.
///
/// 终端本体是纯显示（DisplayOnlyTerminalView），软键盘输入全部从这里与成文层走 client.sendInput。
struct TerminalInputArea: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    var inlineKeypad = false
    /// Space below the keys: `railBottomGap` where the page runs to the screen's bottom edge.
    var bottomGap: CGFloat = 8
    /// How much of the extra keys show above the key rows, 0 … their natural height.
    var keypadReveal: CGFloat = 0
    /// The extra keys' natural height.
    let onKeypadHeight: (CGFloat) -> Void
    /// The resting dock's height (the key rows): the terminal ends above it.
    let onRestingHeight: (CGFloat) -> Void
    /// A vertical drag over the keys: the translation so far.
    let onKeypadDrag: (CGFloat) -> Void
    /// The drag ended: its predicted final translation (a flick carries on).
    let onKeypadDragEnd: (CGFloat) -> Void
    /// VoiceOver's expand / collapse action.
    let onKeypadToggle: () -> Void
    /// Open the secret request sheet of the active terminal.
    let onOpenSecret: () -> Void
    /// The input key's tap: the compose layer with the system keyboard.
    let onCompose: () -> Void
    /// The input key's hold to talk (see `HoldToTalk`).
    let onDictatePrewarm: () -> Void
    let onDictateBegin: () -> Void
    let onDictateMove: (CGPoint) -> Void
    let onDictateEnd: () -> Void
    let onDictateAbort: () -> Void

    /// The extra keys' natural height (measured at a fixed size, so it never feeds back).
    @State private var extrasHeight: CGFloat = 0
    /// A keypad drag is under way. Resets by itself however the drag ends — including when the
    /// system cancels it, where `onEnded` never runs; the reset then settles the keypad.
    @GestureState private var draggingKeypad = false
    /// The last drag's predicted end, for settling a cancelled drag.
    @State private var lastPredictedTranslation: CGFloat = 0


    private var sender: TerminalKeySender {
        TerminalKeySender(client: client, task: task)
    }

    private var agent: Coflux_V1_SessionAgentRef? {
        task.flatMap { client.agent(forTask: $0) }
    }

    private var waitingState: String? {
        guard let state = agent?.state, state == "approval" || state == "question" else { return nil }
        return state
    }

    private var pendingSecret: SecretRequestInfo? {
        task.flatMap { client.pendingSecretRequests(taskID: $0.id).first }
    }

    var body: some View {
        Group {
            if inlineKeypad {
                VStack(spacing: 7) {
                    notice
                        .padding(.bottom, 3)
                    keyRows
                    TerminalExtraKeys(client: client, task: task)
                }
                .padding(.horizontal, Self.sideInset)
                .padding(.vertical, 8)
                .background(Theme.background)
            } else {
                dock
            }
        }
        .animation(.smooth(duration: 0.2), value: waitingState)
    }

    private var dock: some View {
        // 0 … 1: how far the extra keys are out.
        let progress = extrasHeight > 0 ? min(max(keypadReveal / extrasHeight, 0), 1) : 0
        return VStack(spacing: 0) {
            // Above the quick rows, which never move: always mounted at their natural height and
            // shown through a window that grows upwards from the quick rows, so the row nearest
            // them comes out first, as if rising from behind them; the keys fade and settle from
            // slightly smaller while they come.
            TerminalExtraKeys(client: client, task: task)
                .padding(.horizontal, Self.sideInset)
                .padding(.top, 8)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    extrasHeight = height
                    onKeypadHeight(height)
                }
                .opacity(progress)
                .scaleEffect(0.92 + 0.08 * progress, anchor: .bottom)
                .frame(height: keypadReveal, alignment: .bottom)
                .clipped()
                // Hit-testable while a drag runs: dropping hit testing mid-drag (as the keys
                // shrink) would cancel the drag and leave the keypad half out.
                .allowsHitTesting(progress > 0.9 || draggingKeypad)
                .accessibilityHidden(keypadReveal == 0)
            keyRows
                .padding(.horizontal, Self.sideInset)
                .padding(.top, 8)
                .padding(.bottom, bottomGap)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onRestingHeight($0) }
        }
        .background(Theme.terminal)
        // One vertical drag over the whole dock — keys and gaps: up brings the extra keys
        // out, down puts them away. Simultaneous, so it never takes a key's tap away; per-key
        // high-priority drags lost to the keys' own gestures on the device. The host ignores it
        // while talking, where the finger slides up from the input key onto 发送 / 取消.
        .simultaneousGesture(keypadDrag(minimumDistance: 10))
        // A drag the system cancelled never reaches onEnded: settle it here. After a normal end
        // this second call finds no drag running and does nothing.
        .onChange(of: draggingKeypad) { _, dragging in
            if !dragging { onKeypadDragEnd(lastPredictedTranslation) }
        }
        // No handle (user's call, 2026-11-08): the swipe over the keys is the whole gesture.
        // VoiceOver gets it as an action.
        .accessibilityAction(named: keypadReveal > 0 ? "收起按键" : "展开按键") { onKeypadToggle() }
        // Outside the measured size, floating just above the dock's top edge — so it rises with
        // the extra keys — over the terminal's last line: the notice never resizes the terminal
        // (D13).
        .overlay(alignment: .top) {
            notice
                .padding(.horizontal, Self.sideInset)
                .alignmentGuide(.top) { $0[.bottom] }
        }
    }

    /// The keys' side margins: nearly flush, lined up with the terminal's text above.
    static let sideInset: CGFloat = 4

    /// The keys' bottom gap where the page runs to the screen's bottom edge (bars on the rail):
    /// their bottom edge lines up with the rail's lowest button, measured on the Duo's outer
    /// display. Elsewhere the safe area already keeps them off the edge.
    static let railBottomGap: CGFloat = 25

    /// Global coordinates: the dock moves under the finger while it drags, and a local
    /// translation would feed back into itself.
    private func keypadDrag(minimumDistance: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: minimumDistance, coordinateSpace: .global)
            .updating($draggingKeypad) { _, state, _ in state = true }
            .onChanged { value in
                lastPredictedTranslation = value.predictedEndTranslation.height
                onKeypadDrag(value.translation.height)
            }
            .onEnded { onKeypadDragEnd($0.predictedEndTranslation.height) }
    }

    // MARK: Notice bar

    @ViewBuilder
    private var notice: some View {
        if let secret = pendingSecret {
            Button(action: onOpenSecret) {
                noticeBar(
                    mark: .secret,
                    title: "\(agent?.agent ?? "Agent") 请求输入 \(secret.name)",
                    detail: "点按提供，内容只发送到该设备"
                )
            }
            .buttonStyle(.plain)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if let state = waitingState, let agent {
            let name = agent.agent.isEmpty ? "agent" : agent.agent
            noticeBar(
                mark: .agent(agent.agent),
                title: state == "approval" ? "\(name) 等待批准" : "\(name) 等待回答",
                detail: agent.message.isEmpty ? nil : agent.message
            )
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    private func noticeBar(mark: AgentAvatar.Mark, title: String, detail: String?) -> some View {
        HStack(spacing: 10) {
            AgentAvatar(mark: mark, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                    .lineLimit(1)
                if let detail {
                    Text(detail)
                        .font(Theme.Fonts.label)
                        .foregroundStyle(Theme.foreground.opacity(0.8))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Self.sideInset)
        .padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
        .background(Theme.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.warning.opacity(0.3), lineWidth: 1))
        .padding(.bottom, 2)
    }

    // MARK: Key row

    /// Two rows on seven equal columns, the microphone two columns wide beside ↑ and a tall ⏎
    /// spanning both rows (user's layout, 2026-11-08):
    ///
    ///     esc  tab  [  🎤  ]  ↑  ⌫  ⏎
    ///     ^C   ^D   /    ←    ↓  →  ⏎
    ///
    /// While the agent waits (`approval` / `question`) esc, tab and ^C turn into the amber option
    /// keys 1 2 3 — only the keys' bytes are sent, the menu text is never parsed. Every key but the
    /// microphone also drags the extra keys out; the microphone is left out, so sliding up from it
    /// while talking (onto 发送 / 取消) never moves them.
    private var keyRows: some View {
        let height = Theme.Metrics.keyHeight
        let spacing: CGFloat = 7
        // The column width comes from the space offered, never from a measurement of the keys:
        // sizing the keys from the dock's own measured width fed back into that width and spun
        // SwiftUI in an endless layout loop until the watchdog killed the app (seen on the Duo).
        return GeometryReader { proxy in
            let column = max(0, (proxy.size.width - spacing * 6) / 7)
            keyColumns(column: column, height: height, spacing: spacing)
        }
        .frame(height: height * 2 + spacing)
    }

    /// Seven columns of `column` each: ⏎ takes one, the microphone two.
    private func keyColumns(column: CGFloat, height: CGFloat, spacing: CGFloat) -> some View {
        let waiting = waitingState != nil
        return HStack(spacing: spacing) {
            VStack(spacing: spacing) {
                HStack(spacing: spacing) {
                    terminalKeys {
                        if waiting {
                            TerminalKey(sender: sender, label: "1", style: .hot, height: height) { "1" }
                            TerminalKey(sender: sender, label: "2", style: .hot, height: height) { "2" }
                        } else {
                            TerminalKey(sender: sender, label: "esc") { "\u{1b}" }
                            TerminalKey(sender: sender, label: "tab") { "\t" }
                        }
                    }
                    micKey(height: height)
                        .frame(width: column * 2 + spacing)
                    terminalKeys {
                        RepeatKey(sender: sender, label: "↑") { sender.arrowBytes("A") }
                        RepeatKey(sender: sender, systemImage: "delete.left") { "\u{7f}" }
                            .accessibilityLabel("删除")
                    }
                }
                HStack(spacing: spacing) {
                    terminalKeys {
                        if waiting {
                            TerminalKey(sender: sender, label: "3", style: .hot, height: height) { "3" }
                        } else {
                            TerminalKey(sender: sender, label: "^C", style: .destructive) { "\u{03}" }
                        }
                        TerminalKey(sender: sender, label: "^D") { "\u{04}" }
                        TerminalKey(sender: sender, label: "/") { "/" }
                        RepeatKey(sender: sender, label: "←") { sender.arrowBytes("D") }
                        RepeatKey(sender: sender, label: "↓") { sender.arrowBytes("B") }
                        RepeatKey(sender: sender, label: "→") { sender.arrowBytes("C") }
                    }
                }
            }
            terminalKeys {
                TerminalKey(sender: sender, systemImage: "return", style: .enter, height: height * 2 + spacing) { "\r" }
                    .accessibilityLabel("回车")
            }
            .frame(width: column)
        }
    }

    /// A `Group`, not a stack: its modifiers land on each key, so every key keeps an equal share
    /// of the row's width with the microphone key.
    private func terminalKeys(@ViewBuilder _ keys: () -> some View) -> some View {
        Group {
            keys()
        }
        .disabled(sender.sessionID == nil)
        .opacity(sender.sessionID == nil ? 0.45 : 1)
    }

    /// Hold to talk (the dictation overlay covers the page; slide onto 发送 / 取消 or lift for
    /// the confirm state). A tap only answers with a light haptic: talking needs the hold.
    /// Tap: type (the compose layer with the system keyboard). Hold: talk.
    private func micKey(height: CGFloat) -> some View {
        KeyCap(height: height)
            .overlay {
                HStack(spacing: 10) {
                    Image(systemName: "keyboard")
                    Rectangle()
                        .fill(Theme.border)
                        .frame(width: 1, height: 16)
                    Image(systemName: "mic.fill")
                }
                .font(Theme.Fonts.key)
                .foregroundStyle(Theme.foreground)
            }
            .onTapGesture { onCompose() }
            .modifier(HoldToTalk(
                onPrewarm: onDictatePrewarm,
                onBegin: onDictateBegin,
                onMove: onDictateMove,
                onEnd: onDictateEnd,
                onAbort: onDictateAbort
            ))
            .accessibilityElement()
            .accessibilityLabel("输入")
            .accessibilityHint("轻点打字，按住说话")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onCompose() }
    }
}

// MARK: - The extra keys

/// The keys the two quick rows leave out (user's call, 2026-11-08: pulling the dock up shows only
/// what is not already on screen), on the same seven columns:
///
///     1   2   3   4   q   :   ~
///     ⇧⇥  ^R  ^U  ^L  ^Z  |   ^W
///
/// Pulled out below the quick rows, inline in the laptop pose, or as a sheet in a short window.
/// 粘贴, 相册 and 文件 live on the toolbar (粘贴 and 附件).
struct TerminalExtraKeys: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?

    private var sender: TerminalKeySender {
        TerminalKeySender(client: client, task: task)
    }

    var body: some View {
        VStack(spacing: 7) {
            HStack(spacing: 7) {
                ForEach(["1", "2", "3", "4", "q", ":", "~"], id: \.self) { key in
                    TerminalKey(sender: sender, label: key) { key }
                }
            }
            HStack(spacing: 7) {
                TerminalKey(sender: sender, label: "⇧⇥") { "\u{1b}[Z" }
                    .accessibilityLabel("Shift Tab")
                TerminalKey(sender: sender, label: "^R") { "\u{12}" }
                TerminalKey(sender: sender, label: "^U") { "\u{15}" }
                TerminalKey(sender: sender, label: "^L") { "\u{0c}" }
                TerminalKey(sender: sender, label: "^Z") { "\u{1a}" }
                TerminalKey(sender: sender, label: "|") { "|" }
                TerminalKey(sender: sender, label: "^W") { "\u{17}" }
            }
        }
        .disabled(sender.sessionID == nil)
        .opacity(sender.sessionID == nil ? 0.45 : 1)
    }
}

/// 相册取图入口（plan 071）：PHPickerViewController 系统选择器，app 不触碰照片库权限
/// （免弹权限授权弹窗）。委托回调不保证在主线程（真机已知坑）：关闭 sheet 与把选中
/// 字节交回调用方都经 Task { @MainActor in } 显式跳回。
struct PhotoPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    // ponytail: @MainActor 限定令闭包类型自身 Sendable，nonisolated 委托方法里
    // 把它送进 Task { @MainActor in } 才不会被 Swift 6 严格并发拒绝。
    let onPick: @MainActor (Data, String?) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(isPresented: $isPresented, onPick: onPick)
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let isPresented: Binding<Bool>
        let onPick: @MainActor (Data, String?) -> Void

        init(isPresented: Binding<Bool>, onPick: @escaping @MainActor (Data, String?) -> Void) {
            self.isPresented = isPresented
            self.onPick = onPick
        }

        nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let provider = results.first?.itemProvider
            let typeIdentifier = provider?.registeredTypeIdentifiers.first
            Task { @MainActor in self.isPresented.wrappedValue = false }
            guard let provider, let typeIdentifier else { return }
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { [onPick] data, _ in
                guard let data else { return }
                Task { @MainActor [onPick] in onPick(data, typeIdentifier) }
            }
        }
    }
}

/// 文件 App 取文件入口（plan 071）：UIDocumentPickerViewController asCopy: true——
/// 拿到的是沙盒内拷贝，免 startAccessingSecurityScopedResource 配对管理（漏配对读取
/// 直接失败，真机已知坑）。委托回调不保证在主线程，同 PhotoPicker 显式跳回处理。
struct FilePicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    // ponytail: 同 PhotoPicker.onPick——@MainActor 限定让闭包类型 Sendable。
    let onPick: @MainActor (URL) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.delegate = context.coordinator
        picker.allowsMultipleSelection = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(isPresented: $isPresented, onPick: onPick)
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let isPresented: Binding<Bool>
        let onPick: @MainActor (URL) -> Void

        init(isPresented: Binding<Bool>, onPick: @escaping @MainActor (URL) -> Void) {
            self.isPresented = isPresented
            self.onPick = onPick
        }

        nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            Task { @MainActor in self.isPresented.wrappedValue = false }
            guard let url = urls.first else { return }
            Task { @MainActor [onPick] in onPick(url) }
        }

        nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            Task { @MainActor in self.isPresented.wrappedValue = false }
        }
    }
}

/// 图片处理管线（plan 071，语义对照 web terminal-pane.tsx 的 compressToBudget）：
/// HEIC 一律转 JPEG；PNG/JPEG 在预算内原字节直传（保无损）；其余（含超预算 PNG/
/// JPEG）按质量阶梯压缩，仍超限再减半分辨率重来。
private enum ImagePipeline {
    /// 与 web PASTE_BUDGET_BYTES 同预算（terminal-pane.tsx），蜂窝网络传输带宽折衷值。
    static let budgetBytes = 3_500_000
    private static let minDimension: CGFloat = 64
    private static let qualities: [CGFloat] = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]

    /// nonisolated + async：经 await 从 MainActor 调用时真正跑在后台线程，不占用
    /// 调用方（DictationSession.requestSpeechPermission 同构手法）。
    nonisolated static func process(data: Data, typeIdentifier: String?) async -> (Data, String)? {
        if let ext = losslessExt(for: typeIdentifier), data.count <= budgetBytes {
            return (data, ext)
        }
        guard let image = UIImage(data: data), let compressed = compressToBudget(image, budget: budgetBytes) else {
            return nil
        }
        return (compressed, ".jpg")
    }

    private static func losslessExt(for typeIdentifier: String?) -> String? {
        guard let typeIdentifier, let type = UTType(typeIdentifier) else { return nil }
        if type.conforms(to: .png) { return ".png" }
        if type.conforms(to: .jpeg) { return ".jpg" }
        return nil
    }

    /// 先在原分辨率按质量阶梯降，仍超限再减半分辨率重来；两者都到头则回落已压出
    /// 的最小结果（与 web compressToBudget 同算法）。
    private static func compressToBudget(_ image: UIImage, budget: Int) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        var width = CGFloat(cgImage.width)
        var height = CGFloat(cgImage.height)
        var smallest: Data?
        while true {
            let size = CGSize(width: max(1, width.rounded()), height: max(1, height.rounded()))
            let renderer = UIGraphicsImageRenderer(size: size)
            let resized = renderer.image { _ in
                UIImage(cgImage: cgImage).draw(in: CGRect(origin: .zero, size: size))
            }
            for quality in qualities {
                guard let encoded = resized.jpegData(compressionQuality: quality) else { continue }
                if smallest == nil || encoded.count < smallest!.count { smallest = encoded }
                if encoded.count <= budget { return encoded }
            }
            if min(width, height) <= minDimension { break }
            width /= 2
            height /= 2
        }
        return smallest
    }
}

/// 可调强度毛玻璃（成文层与对讲蒙层的底）：暂停的 UIViewPropertyAnimator 用 fractionComplete
/// 控制模糊深度（0-1 连续），这是"淡毛玻璃"的唯一正确姿势——直接给材质设 opacity 会禁用
/// 模糊、退化成不透明灰遮罩（真机踩过）。强度渐变自带淡入淡出。
struct VariableBlurView: UIViewRepresentable {
    /// 0 = 无模糊，1 = 完整 ultraThinMaterialDark
    var intensity: CGFloat

    @MainActor
    final class Coordinator {
        var animator: UIViewPropertyAnimator?
        var stepper: Task<Void, Never>?
        var current: CGFloat = 0

        func set(_ target: CGFloat) {
            stepper?.cancel()
            let start = current
            guard abs(target - start) > 0.001 else { return }
            let steps = 10
            stepper = Task { [weak self] in
                for step in 1...steps {
                    try? await Task.sleep(for: .milliseconds(12))
                    guard let self, !Task.isCancelled else { return }
                    self.current = start + (target - start) * CGFloat(step) / CGFloat(steps)
                    self.animator?.fractionComplete = self.current
                }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: nil)
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) {
            view.effect = UIBlurEffect(style: .systemUltraThinMaterialDark)
        }
        animator.pausesOnCompletion = true
        context.coordinator.animator = animator
        return view
    }

    func updateUIView(_ view: UIVisualEffectView, context: Context) {
        context.coordinator.set(intensity)
    }

    static func dismantleUIView(_ uiView: UIVisualEffectView, coordinator: Coordinator) {
        coordinator.stepper?.cancel()
        coordinator.animator?.stopAnimation(true)
    }
}

/// 成文层（plan 053 → Duo redesign, mockup O4）：the composer card expanded over the frozen
/// terminal, riding on the system keyboard (an overlay over the keyboard-immune page: the terminal
/// and the dock underneath neither move nor resize while the keyboard is up, D13).
/// Send writes the text only — the user presses Enter themselves (2026-11-08, reverting plan D10's
/// text + Enter). When the terminal is not ready nothing is sent: the draft and the layer stay,
/// with the hint "终端未运行". 点卡片外任意处取消（草稿保留）。
struct TerminalComposeOverlay: View {
    @Binding var draft: String
    /// The active terminal is running and has a session.
    let ready: Bool
    let placeholder: String
    /// Sends the draft (text only, no Enter); returns whether it was sent.
    let onSend: () -> Bool
    /// 相册 shortcut: the picked image is uploaded to the terminal.
    let onPhoto: (Data, String?) -> Void
    let onDismiss: () -> Void
    @FocusState private var focused: Bool
    /// 自绘淡入淡出（呈现层动画已禁）：毛玻璃强度与卡片透明度同步渐变
    @State private var appeared = false
    @State private var notReadyHint = false
    @State private var showingPhotoPicker = false
    /// How far the system keyboard reaches up into this layer.
    @State private var keyboardOverlap: CGFloat = 0
    /// The layer's bottom edge in screen coordinates.
    @State private var layerBottom: CGFloat = 0

    /// Follows the keyboard with its own animation curve and duration.
    private func keyboardChanged(_ note: Notification, hiding: Bool = false) {
        let info = note.userInfo ?? [:]
        let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let overlap = hiding ? 0 : max(0, layerBottom - end.minY)
        withAnimation(.easeOut(duration: duration)) { keyboardOverlap = overlap }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // 控制中心式清透重糊的最优公开逼近（调研见 plan 053）
            VariableBlurView(intensity: appeared ? 0.65 : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { fadeOutAndDismiss() }
            VStack(alignment: .leading, spacing: 10) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1 ... 6)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .font(Theme.Fonts.body)
                    .padding(.top, 4)
                    .onChange(of: draft) { _, _ in notReadyHint = false }
                HStack(spacing: 6) {
                    Button {
                        showingPhotoPicker = true
                    } label: {
                        Image(systemName: "photo")
                            .font(Theme.Fonts.label.weight(.semibold))
                            .foregroundStyle(Theme.mutedForeground)
                            .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                            .background(Theme.accentSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!ready)
                    .accessibilityLabel("从相册上传到终端")
                    Spacer(minLength: 8)
                    if notReadyHint {
                        Text("终端未运行")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.warning)
                    }
                    sendButton
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 10)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.Metrics.expandedComposerRadius))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Metrics.expandedComposerRadius)
                    .strokeBorder(Theme.border, lineWidth: 1)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8 + keyboardOverlap)
            .opacity(appeared ? 1 : 0)
        }
        // The page underneath ignores the keyboard, and so does this layer: it lifts its card by
        // the keyboard's measured overlap itself, so nothing else is ever laid out again.
        .ignoresSafeArea(.keyboard)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { layerBottom = $0 }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            keyboardChanged(note)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { note in
            keyboardChanged(note, hiding: true)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            focused = true
        }
        .sheet(isPresented: $showingPhotoPicker) {
            PhotoPicker(isPresented: $showingPhotoPicker) { data, typeIdentifier in
                onPhoto(data, typeIdentifier)
            }
        }
    }

    private var sendButton: some View {
        let empty = draft.isEmpty
        return Button {
            send()
        } label: {
            Image(systemName: "arrow.up")
                .font(Theme.Fonts.label.weight(.bold))
                .foregroundStyle(empty ? Theme.subtleForeground : Theme.primaryForeground)
                .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                .background(empty ? Theme.accentSurface : Theme.primary, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("发送")
    }

    private func send() {
        guard !draft.isEmpty else { return }
        guard ready else {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            notReadyHint = true
            return
        }
        if onSend() {
            fadeOutAndDismiss()
        }
    }

    /// 收场时序：模糊/卡片 ~120ms 淡完 → 系统键盘 ~250ms 落完 → 320ms 时才拆呈现层。
    /// 提前拆会把淡出中的模糊和下落中的键盘硬切掉——"结尾一卡"的根因（真机踩过）。
    private func fadeOutAndDismiss() {
        focused = false
        withAnimation(.easeIn(duration: 0.12)) { appeared = false }
        Task {
            try? await Task.sleep(for: .milliseconds(320))
            onDismiss()
        }
    }
}
