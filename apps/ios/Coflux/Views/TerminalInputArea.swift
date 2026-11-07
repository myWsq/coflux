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

/// The terminal page's dock (plan D11/D13, mockup O2/O3): an optional notice bar, a key row that
/// follows the agent, and a one-line composer, pinned to the bottom of the content area.
///
/// - Key row: when the active terminal's agent is in `approval` or `question` it becomes the
///   enlarged option keys `1 2 3 ↑ ↓ ⏎` (only the keys' bytes are sent — the menu text is never
///   parsed); otherwise `esc ^C tab ↑ ↓ /`, plus `← →` when the dock is wide enough to keep keys
///   at the mockup's size. The row has one fixed height, and the notice bar floats above the dock
///   outside its measured size, so neither changes the terminal's size.
/// - Composer: tap opens the compose layer, a long press starts dictation; the send button sends
///   the draft with Enter (a long press sends it without).
/// - Short window: `foldKeyRow` moves the key row into the 按键 toolbar item (only the composer
///   stays). Laptop pose: `inlineKeypad` shows the composer above the full keypad instead.
///
/// 终端本体是纯显示（DisplayOnlyTerminalView），软键盘输入全部从这里走 client.sendInput。
struct TerminalInputArea: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    /// 草稿宿主持有：占位条只做预览，点击进与系统键盘同层的成文层
    let draft: String
    var foldKeyRow = false
    var inlineKeypad = false
    let onCompose: () -> Void
    /// Send the draft (tap: with Enter; long press: without).
    let onSend: (_ withEnter: Bool) -> Void
    /// Open the secret request sheet of the active terminal.
    let onOpenSecret: () -> Void
    /// 长按对讲（plan 064；操作台几何 plan 067 → 068；乐观启动 plan 069）：手指落下即请求预热采音
    /// （prewarm，去抖后），长按判定通过才进对讲态（begin，宿主此刻才显示蒙层），未达长按松手则
    /// 请求拆掉预热（abort）。对讲期间手指位置（全局坐标）实时外传，由宿主对蒙层按钮做命中判定。
    let onDictatePrewarm: () -> Void
    let onDictateBegin: () -> Void
    let onDictateMove: (CGPoint) -> Void
    let onDictateEnd: () -> Void
    let onDictateAbort: () -> Void

    @State private var dictateActive = false
    @State private var prewarmTask: Task<Void, Never>?
    /// 对讲预兆的显现度（0-1，plan 069）：按下即向 1 渐变，见 pressChanged
    @State private var dictateHint: Double = 0
    /// 按压视觉态：GestureState 在手势结束/被系统取消时自动复位
    @GestureState private var pressing = false
    @State private var width: CGFloat = 0
    @State private var sendLongPressed = false

    /// 预热去抖（plan 069）：手指落下到真正起采音之间的等待。正常点击（~60-120ms 抬手）必须被它
    /// 完全滤掉；它远短于长按阈值 0.28s，不影响"按下即说"。长按判定与点按/长按的消歧仍全归系统
    /// 手势，这个定时器只决定预热何时开始。
    private static let prewarmDelay = Duration.milliseconds(120)
    /// `← →` join the row from this dock width on: 8 keys stay at least the mockup's ~55 pt.
    static let arrowsWidth: CGFloat = 520

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
        VStack(spacing: 10) {
            if inlineKeypad {
                notice
                composer
                TerminalKeypad(client: client, task: task)
            } else {
                if !foldKeyRow {
                    keyRow
                }
                composer
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background {
            if inlineKeypad {
                Theme.background
            } else {
                // The terminal ends above the dock; a short fade keeps the seam soft.
                LinearGradient(colors: [Theme.terminal.opacity(0), Theme.terminal], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.2))
            }
        }
        // Outside the measured size: showing or hiding it never resizes the terminal (D13).
        .overlay(alignment: .top) {
            if !inlineKeypad {
                notice
                    .padding(.horizontal, 12)
                    .alignmentGuide(.top) { $0[.bottom] }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .animation(.smooth(duration: 0.2), value: waitingState)
    }

    // MARK: Notice bar

    @ViewBuilder
    private var notice: some View {
        if let secret = pendingSecret {
            Button(action: onOpenSecret) {
                noticeBar(
                    mark: .secret,
                    title: "\(agent?.agent ?? "Agent") 请求输入 \(secret.name)",
                    detail: "点这里提供，值只交给设备"
                )
            }
            .buttonStyle(.plain)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if let state = waitingState, let agent {
            let name = agent.agent.isEmpty ? "agent" : agent.agent
            noticeBar(
                mark: .agent(agent.agent),
                title: state == "approval" ? "\(name) 要你确认" : "\(name) 在问你",
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
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
        .background(Theme.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.warning.opacity(0.3), lineWidth: 1))
        .padding(.bottom, 2)
    }

    // MARK: Key row

    private var keyRow: some View {
        HStack(spacing: 7) {
            if waitingState != nil {
                let large = Theme.Metrics.keyHeightLarge
                ForEach(["1", "2", "3"], id: \.self) { digit in
                    TerminalKey(sender: sender, label: digit, style: .hot, height: large, large: true) { digit }
                }
                RepeatKey(sender: sender, label: "↑", height: large, large: true) { sender.arrowBytes("A") }
                RepeatKey(sender: sender, label: "↓", height: large, large: true) { sender.arrowBytes("B") }
                TerminalKey(sender: sender, systemImage: "return", style: .enter, height: large, large: true) { "\r" }
            } else {
                TerminalKey(sender: sender, label: "esc") { "\u{1b}" }
                TerminalKey(sender: sender, label: "^C", style: .destructive) { "\u{03}" }
                TerminalKey(sender: sender, label: "tab") { "\t" }
                RepeatKey(sender: sender, label: "↑") { sender.arrowBytes("A") }
                RepeatKey(sender: sender, label: "↓") { sender.arrowBytes("B") }
                if width >= Self.arrowsWidth {
                    RepeatKey(sender: sender, label: "←") { sender.arrowBytes("D") }
                    RepeatKey(sender: sender, label: "→") { sender.arrowBytes("C") }
                }
                TerminalKey(sender: sender, label: "/") { "/" }
            }
        }
        // One height for both rows: switching never changes the dock's size.
        .frame(height: Theme.Metrics.keyHeightLarge)
        .disabled(sender.sessionID == nil)
        .opacity(sender.sessionID == nil ? 0.45 : 1)
    }

    // MARK: Composer

    private var placeholder: String {
        guard let name = agent?.agent, !name.isEmpty else { return "输入命令…" }
        return "回复 \(name)…"
    }

    private var composer: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Text(draft.isEmpty ? placeholder : draft)
                    .font(Theme.Fonts.body)
                    .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "mic.fill")
                    .font(Theme.Fonts.label.weight(.semibold))
                    .foregroundStyle(dictateHint > 0.5 ? Theme.primary : Theme.mutedForeground)
                    .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                    .background(Theme.accentSurface, in: Circle())
                    .accessibilityLabel("长按说话")
            }
            .contentShape(Rectangle())
            .onTapGesture { onCompose() }
            .gesture(composerGesture)
            .onChange(of: pressing) { _, down in pressChanged(down) }
            // 手指还按着时输入区被拆掉：GestureState 复位的 onChange 到不了这里，热着的预热
            // session 会连着麦克风悬在后台，手动补一次抬手
            .onDisappear { pressChanged(false) }
            sendButton
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .frame(height: Theme.Metrics.composerHeight)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.Metrics.composerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Metrics.composerRadius)
                .strokeBorder(Theme.border, lineWidth: 1)
            RoundedRectangle(cornerRadius: Theme.Metrics.composerRadius)
                .strokeBorder(Theme.primary, lineWidth: 1)
                .opacity(dictateHint)
        }
        .scaleEffect(pressing ? 0.98 : 1)
        .animation(.easeOut(duration: 0.08), value: pressing)
    }

    private var sendButton: some View {
        let empty = draft.isEmpty
        return Button {
            // A long press already sent the text without Enter.
            if sendLongPressed {
                sendLongPressed = false
                return
            }
            onSend(true)
        } label: {
            Image(systemName: "arrow.up")
                .font(Theme.Fonts.label.weight(.bold))
                .foregroundStyle(empty ? Theme.subtleForeground : Theme.primaryForeground)
                .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                .background(empty ? Theme.accentSurface : Theme.primary, in: Circle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                guard !draft.isEmpty else { return }
                sendLongPressed = true
                onSend(false)
            }
        )
        .disabled(empty)
        .accessibilityLabel("发送并回车")
    }

    /// 手指落下/离开（plan 069）：`pressing` 由 sequenced 手势的 .updating 驱动，是最早的按下
    /// 信号（早于 0.28s 长按判定）——视觉预兆渐显，去抖后请求预热采音；抬手时若长按未判定通过
    /// 则请求拆掉（宿主按"蒙层是否已显示"自判，与 onEnded 的先后无关）。
    private func pressChanged(_ down: Bool) {
        withAnimation(down ? .easeIn(duration: 0.3) : .easeOut(duration: 0.12)) {
            dictateHint = down ? 1 : 0
        }
        prewarmTask?.cancel()
        prewarmTask = nil
        guard down else {
            onDictateAbort()
            return
        }
        prewarmTask = Task {
            // sleep 被取消时 try? 会立刻返回，必须再查一次 isCancelled
            try? await Task.sleep(for: Self.prewarmDelay)
            guard !Task.isCancelled else { return }
            onDictatePrewarm()
        }
    }

    /// 长按对讲手势（plan 066 复议）：不自造长按判定——LongPressGesture（0.28s，2026-08-01 用户
    /// 实测定案）sequenced DragGesture 是 Apple 官方"长按后拖动"组合，判定时长/移动容差/与点按的
    /// 消歧全交系统；判定通过瞬间给触觉，随后 drag 把手指位置（.global，与蒙层命中判定同一坐标
    /// 空间）持续外传。短按由 .onTapGesture 独立消歧。
    private var composerGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.28)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
            .updating($pressing) { _, state, _ in
                state = true
            }
            .onChanged { value in
                guard case .second(true, let drag) = value else { return }
                if !dictateActive {
                    dictateActive = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    onDictateBegin()
                }
                if let drag { onDictateMove(drag.location) }
            }
            .onEnded { _ in
                guard dictateActive else { return }
                dictateActive = false
                onDictateEnd()
            }
    }
}

// MARK: - The full keypad

/// The old control pad as a panel (mockup O6): a sheet that can stay open while keys are pressed,
/// or inline below the composer in the laptop pose. Every key sends what the old pad sent; paste
/// and uploads keep plan 071's behaviour (raw image bytes, HEIC → JPEG, 30 MB cap, 60 s timeout).
///
///     esc  1   2   3   4   ⌫
///     tab  q   ^D  ^C  ^U  ^L
///     /    :   ~   ↑   |   ⏎
///     ^R   ^Z  ←   ↓   →   ⏎
struct TerminalKeypad: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    /// Present in the sheet: a header with a close button.
    var onClose: (() -> Void)?

    @State private var showingAttachMenu = false
    @State private var showingPhotoPicker = false
    @State private var showingFilePicker = false

    private var sender: TerminalKeySender {
        TerminalKeySender(client: client, task: task)
    }

    private let spacing: CGFloat = 8
    private let height = Theme.Metrics.keyHeightLarge

    var body: some View {
        VStack(spacing: 12) {
            if let onClose {
                HStack {
                    Text("按键")
                        .font(Theme.Fonts.rowTitle)
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(Theme.Fonts.label.weight(.semibold))
                            .foregroundStyle(Theme.mutedForeground)
                            .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                            .background(Theme.accentSurface, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭按键")
                }
            }
            VStack(spacing: spacing) {
                HStack(spacing: spacing) {
                    key("esc", "\u{1b}")
                    ForEach(["1", "2", "3", "4"], id: \.self) { key($0, $0) }
                    RepeatKey(sender: sender, systemImage: "delete.left", height: height) { "\u{7f}" }
                }
                HStack(spacing: spacing) {
                    key("tab", "\t")
                    key("q", "q")
                    key("^D", "\u{04}")
                    key("^C", "\u{03}", style: .destructive)
                    key("^U", "\u{15}")
                    key("^L", "\u{0c}")
                }
                // Six equal columns; the last is the tall ⏎ spanning both rows.
                HStack(spacing: spacing) {
                    column { key("/", "/") } bottom: { key("^R", "\u{12}") }
                    column { key(":", ":") } bottom: { key("^Z", "\u{1a}") }
                    column { key("~", "~") } bottom: {
                        RepeatKey(sender: sender, label: "←", height: height) { sender.arrowBytes("D") }
                    }
                    column {
                        RepeatKey(sender: sender, label: "↑", height: height) { sender.arrowBytes("A") }
                    } bottom: {
                        RepeatKey(sender: sender, label: "↓", height: height) { sender.arrowBytes("B") }
                    }
                    column { key("|", "|") } bottom: {
                        RepeatKey(sender: sender, label: "→", height: height) { sender.arrowBytes("C") }
                    }
                    TerminalKey(sender: sender, systemImage: "return", style: .enter, height: height * 2 + spacing) { "\r" }
                        .accessibilityLabel("回车")
                }
            }
            .disabled(sender.sessionID == nil)
            .opacity(sender.sessionID == nil ? 0.45 : 1)
            HStack(spacing: 10) {
                wideButton("粘贴", systemImage: "doc.on.clipboard") { sender.paste() }
                    .accessibilityLabel("粘贴到终端")
                wideButton("相册 / 文件", systemImage: "paperclip") { showingAttachMenu = true }
                    .accessibilityLabel("上传文件到终端")
                    .confirmationDialog("上传到终端", isPresented: $showingAttachMenu, titleVisibility: .visible) {
                        Button("相册") { showingPhotoPicker = true }
                        Button("文件") { showingFilePicker = true }
                        Button("取消", role: .cancel) {}
                    }
            }
            .disabled(sender.sessionID == nil || sender.uploading)
            .opacity(sender.sessionID == nil || sender.uploading ? 0.5 : 1)
        }
        // 两个 picker 的 sheet 挂在根上：菜单收起与 sheet 呈现同锚点会撞呈现时序
        .sheet(isPresented: $showingPhotoPicker) {
            PhotoPicker(isPresented: $showingPhotoPicker) { data, typeIdentifier in
                sender.uploadImage(data: data, typeIdentifier: typeIdentifier, prefix: "photo")
            }
        }
        .sheet(isPresented: $showingFilePicker) {
            FilePicker(isPresented: $showingFilePicker) { url in
                sender.uploadFile(url: url)
            }
        }
    }

    private func key(_ label: String, _ bytes: String, style: KeyStyle = .normal) -> some View {
        TerminalKey(sender: sender, label: label, style: style, height: height) { bytes }
    }

    private func column(
        @ViewBuilder top: () -> some View,
        @ViewBuilder bottom: () -> some View
    ) -> some View {
        VStack(spacing: spacing) {
            top()
            bottom()
        }
    }

    private func wideButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.foreground)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Theme.accentSurface, in: Capsule())
        }
        .buttonStyle(KeyPressStyle())
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
/// terminal, riding on the system keyboard (fullScreenCover with a clear background: the terminal
/// and the dock underneath neither move nor resize while the keyboard is up, D13).
/// Send = text + Enter in one write; a long press on send writes the text without Enter
/// (plan D10). When the terminal is not ready nothing is sent: the draft and the layer stay, with
/// the hint "终端未运行". 点卡片外任意处取消（草稿保留）。
struct TerminalComposeOverlay: View {
    @Binding var draft: String
    /// The active terminal is running and has a session.
    let ready: Bool
    let placeholder: String
    /// Sends the draft; returns whether it was sent.
    let onSend: (_ withEnter: Bool) -> Bool
    /// 相册 shortcut: the picked image is uploaded to the terminal.
    let onPhoto: (Data, String?) -> Void
    let onDismiss: () -> Void
    @FocusState private var focused: Bool
    /// 自绘淡入淡出（呈现层动画已禁）：毛玻璃强度与卡片透明度同步渐变
    @State private var appeared = false
    @State private var notReadyHint = false
    @State private var showingPhotoPicker = false
    @State private var sendLongPressed = false

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
                    Text(notReadyHint ? "终端未运行" : "发送并回车")
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(notReadyHint ? Theme.warning : Theme.subtleForeground)
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
            .padding(.bottom, 8)
            .opacity(appeared ? 1 : 0)
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
            // A long press already handled this touch.
            if sendLongPressed {
                sendLongPressed = false
                return
            }
            send(withEnter: true)
        } label: {
            Image(systemName: "arrow.up")
                .font(Theme.Fonts.label.weight(.bold))
                .foregroundStyle(empty ? Theme.subtleForeground : Theme.primaryForeground)
                .frame(width: Theme.Metrics.roundButton, height: Theme.Metrics.roundButton)
                .background(empty ? Theme.accentSurface : Theme.primary, in: Circle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                guard !draft.isEmpty else { return }
                sendLongPressed = true
                send(withEnter: false)
            }
        )
        .accessibilityLabel("发送并回车")
        .accessibilityAction(named: "只填字不回车") { send(withEnter: false) }
    }

    private func send(withEnter: Bool) {
        guard !draft.isEmpty else { return }
        guard ready else {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            notReadyHint = true
            return
        }
        if onSend(withEnter) {
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
