import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 终端输入区（plan 053）——移动端两层输入模型：
/// - 成文层：单行原生输入框 + 系统输入法（中文可用），整行编辑一次发送；
///   发送 = 仅落字面文本不回车（plan 054/055 复议 053），回车由控制板大回车键补。
/// - 控制层：精简键盘（数字/Esc//、Tab/⇧Tab/⌫、^C/方向/回车），单键直发。
///   无字母（字母走成文层），故不设粘滞 Ctrl——组合键以专用键给出（^C）。
/// 终端本体是纯显示（DisplayOnlyTerminalView），软键盘输入全部从这里走
/// client.sendInput，路由到激活任务的 session；无 RUNNING session 时禁用。
struct TerminalInputArea: View {
    let client: CofluxClient
    let task: Coflux_V1_Task?
    /// 草稿宿主持有：占位条只做预览，点击进与系统键盘同层的成文层
    let draft: String
    let onCompose: () -> Void
    /// 长按对讲（plan 064；操作台几何 plan 067 → 068；乐观启动 plan 069）：
    /// 手指落下即请求预热采音（prewarm，去抖后），长按判定通过才进对讲态
    /// （begin，宿主此刻才显示蒙层），未达长按松手则请求拆掉预热（abort）。
    /// 对讲期间手指位置（全局坐标）实时外传，由宿主对蒙层底部两颗按钮做命中
    /// 判定，松手时按最后命中的按钮分发（滑入取消 / 滑入发送 / 原地松手进
    /// 确认态）——本层不判去向，只管把位置递出去。
    let onDictatePrewarm: () -> Void
    let onDictateBegin: () -> Void
    let onDictateMove: (CGPoint) -> Void
    let onDictateEnd: () -> Void
    let onDictateAbort: () -> Void
    @State private var repeatTimer: Timer?
    @State private var dictateActive = false
    @State private var prewarmTask: Task<Void, Never>?
    /// 相册/文件 App 选择器呈现态（plan 071）：sheet(isPresented:) 驱动，
    /// picker 内部选完/取消都会把它拨回 false。
    @State private var showingPhotoPicker = false
    @State private var showingFilePicker = false
    /// 对讲预兆的显现度（0-1，plan 069）：按下即向 1 渐变，见 pressChanged
    @State private var dictateHint: Double = 0
    /// 按压视觉态：GestureState 在手势结束/被系统取消时自动复位，
    /// 不会像手动 @State 那样在手势中断路径上卡住
    @GestureState private var pressing = false

    /// 预热去抖（plan 069）：手指落下到真正起采音之间的等待。AudioCapture 用
    /// `.record` category，激活即打断其它音频播放并点亮状态栏橙点——点一下
    /// 占位条打字不该付这个代价，正常点击（~60-120ms 抬手）必须被它完全滤掉；
    /// 同时它远短于长按阈值 0.28s，不影响"按下即说"。
    /// 注意这不是 plan 066 否掉的自造计时：长按判定与点按/长按的消歧仍全归
    /// 系统手势，这个定时器只决定预热何时开始，不参与任何手势判定。
    private static let prewarmDelay = Duration.milliseconds(120)

    private var sessionID: String? {
        guard let task, task.status == .running, task.hasSessionID else { return nil }
        return task.sessionID
    }

    /// 上传忙态（plan 071）：相册/文件/粘贴三个入口键共享——同一 session 同刻只有
    /// 一次上传在途（CofluxClient.uploadFile 自身也有此门控，这里只管 UI 呈现）。
    private var uploading: Bool {
        sessionID.map { client.uploadingSessionIDs.contains($0) } ?? false
    }

    var body: some View {
        VStack(spacing: 8) {
            composerRow
            padRows
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
        }
        .disabled(sessionID == nil)
        .opacity(sessionID == nil ? 0.45 : 1)
    }

    // MARK: - 成文入口（占位条：预览草稿，点击进成文层——基座冻结，
    // 输入框与系统键盘在独立呈现层同层升降）。收起入口在右下浮键（plan 056）

    private var composerRow: some View {
        HStack {
            Text(draft.isEmpty ? "长按说话・点击输入到终端" : draft)
                .font(Theme.Fonts.label)
                .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.foreground)
                .lineLimit(1)
            Spacer()
            // 常驻占位、只调透明度：条件插入会让预兆显隐时行内布局跳一下
            Image(systemName: "mic.fill")
                .foregroundStyle(Theme.primary)
                .opacity(dictateHint)
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(Theme.input, in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Theme.primary, lineWidth: 1)
                .opacity(dictateHint)
        }
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .scaleEffect(pressing ? 0.97 : 1)
        .animation(.easeOut(duration: 0.08), value: pressing)
        .onTapGesture { onCompose() }
        .gesture(composerGesture)
        .onChange(of: pressing) { _, down in pressChanged(down) }
        // 手指还按着时输入区被拆掉（收起控制板/离开工作区）：GestureState 复位
        // 的 onChange 到不了这里，热着的预热 session 会连着麦克风悬在后台，
        // 手动补一次抬手（蒙层已显示的正常对讲由宿主的 guard 挡住）
        .onDisappear { pressChanged(false) }
    }

    /// 手指落下/离开（plan 069）：`pressing` 由 sequenced 手势的 .updating 驱动，
    /// 是当前能拿到的最早按下信号（早于 0.28s 长按判定），一路管两件事——
    /// - **视觉预兆**：mic 图标与 primary 边框渐显，让长按判定窗口不再是"按了
    ///   没反应"的空白。刻意用慢 easeIn：正常点击（~60-120ms 抬手）时预兆几乎
    ///   不可见，按住不放才完全显现。显式 withAnimation 给自己的曲线，不蹭
    ///   上面按压缩放那条 0.08s。
    /// - **预热采音**：去抖后请求宿主起 session（见 prewarmDelay）；抬手时
    ///   若长按未判定通过则请求拆掉。abort 在宿主侧按"蒙层是否已显示"自判，
    ///   故与 onEnded 的先后顺序无关，正常对讲的松手分发不会被它插一脚。
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

    /// 长按对讲手势（plan 066 复议 2026-07-30）：不自造长按判定——此前
    /// DragGesture+定时器方案里，首个 onChanged 本身滞后于手指落下（要过
    /// 系统手势消歧），自计时叠在这个不确定起点上，实际判定时长远超设定值
    /// 且不稳定（真机投诉根因）。改用 iOS 原生语义：LongPressGesture 系统
    /// 默认参数 sequenced DragGesture（Apple 官方"长按后拖动"组合），判定
    /// 时长/移动容差/与点按的消歧全交系统；判定通过瞬间给触觉（context
    /// menu 惯例），随后 drag 把手指位置持续外传。短按由 .onTapGesture 独立
    /// 消歧，抬手即触发、不等长按超时。
    /// minimumDuration 0.28s（2026-08-01 用户实测定案；系统默认 0.5s 明显
    /// 拖沓，再调需用户拍板）。与 066 结论的分界要看清：被否掉的是**自造
    /// 计时**（DragGesture + Timer——首个 onChanged 本身滞后于手指落下，自
    /// 计时叠在这个不确定起点上，实际判定时长失控），不是给系统手势传参；
    /// 判定与和 .onTapGesture 的消歧此处仍全归系统，不是"又在自造阈值"。
    /// 坐标空间取 .global（plan 067）：蒙层底部按钮的命中判定要和按钮几何
    /// 在同一坐标系里比，local（占位条自身坐标）没法和全屏蒙层对齐。
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

    // MARK: - 控制层

    /// 频率分区布局（2026-07-26 用户定案，第一性推导）：
    /// - 回车 = 最高频 → 竖跨两行大键钉右下角（右拇指落点），primary 高亮；
    /// - 方向簇紧贴回车左侧（菜单流 ↓↓⏎ 零位移），按住连发；
    /// - esc = 打断 agent，高频 → 宽键钉左下角（左拇指落点）；
    /// - 数字 = 快选，中频 → 降为顶部矮行；
    /// - ^C 破坏性大 → 缩小、与回车对角隔离。
    private var padRows: some View {
        VStack(spacing: 6) {
            // 顶排：esc + 数字快选 1-5 + 右上角小⌫（六个等宽键与下块六列大致对齐）
            HStack(spacing: 6) {
                key("esc", bytes: "\u{1b}")
                ForEach(["1", "2", "3", "4", "5"], id: \.self) { digit in
                    key(digit, bytes: digit)
                }
                repeatKey(systemImage: "delete.left", bytes: "\u{7f}")
                    .frame(width: 52)
            }
            // 下块：左区 3 列扩充键（^C 守左下角）+ 收窄方向簇（tab、/ 夹 ↑）+ 竖跨大⏎
            HStack(spacing: 6) {
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        key("tab", bytes: "\t")
                        key("q", bytes: "q")
                        key("^D", bytes: "\u{04}")
                    }
                    HStack(spacing: 6) {
                        key("^C", tint: Theme.destructive, bytes: "\u{03}")
                        key("^U", bytes: "\u{15}")
                        key("^L", bytes: "\u{0c}")
                    }
                }
                .frame(maxWidth: .infinity)
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        pasteKey
                        repeatKey(systemImage: "arrowtriangle.up.fill", bytes: arrowBytes("A"))
                        key("/", bytes: "/")
                    }
                    HStack(spacing: 6) {
                        repeatKey(systemImage: "arrowtriangle.left.fill", bytes: arrowBytes("D"))
                        repeatKey(systemImage: "arrowtriangle.down.fill", bytes: arrowBytes("B"))
                        repeatKey(systemImage: "arrowtriangle.right.fill", bytes: arrowBytes("C"))
                    }
                }
                .frame(width: 150)
                enterKey
            }
            // 上传入口（plan 071）：相册 + 文件 App，与粘贴键同属"输入来源"语义组，
            // 低频独立成行，不扰动上方已手调的控制键几何。
            HStack(spacing: 6) {
                photoKey
                fileKey
            }
        }
    }

    /// 粘贴：剪贴板有图先走上传（plan 071），否则回落系统剪贴板文本直发终端
    /// （移动端独有高频缺口，替代低频 ⇧tab）；剪贴板天然可能多行，包 bracketed
    /// paste 防换行在开 2004 的接收端被当提交。
    private var pasteKey: some View {
        Button {
            if let (data, typeIdentifier) = clipboardImageData() {
                uploadImage(data: data, typeIdentifier: typeIdentifier, prefix: "paste")
                return
            }
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            press("\u{1b}[200~" + text + "\u{1b}[201~")
        } label: {
            keyCap(label: nil, systemImage: "doc.on.clipboard", tint: Theme.foreground, height: 38)
        }
        .disabled(uploading)
        .opacity(uploading ? 0.5 : 1)
        .accessibilityLabel("粘贴到终端")
    }

    /// 剪贴板原始图片字节（plan 071 landmine）：UIPasteboard.image 返回的是系统重新
    /// 解码的 UIImage，会丢原始字节（PNG 截图经它会被静默转成别的编码）；
    /// data(forPasteboardType:) 才是未经改动的原始数据，只在超预算时才允许重编码。
    private func clipboardImageData() -> (Data, String)? {
        let pasteboard = UIPasteboard.general
        for uti in [UTType.png.identifier, UTType.jpeg.identifier, UTType.heic.identifier] {
            if let data = pasteboard.data(forPasteboardType: uti), !data.isEmpty {
                return (data, uti)
            }
        }
        return nil
    }

    /// 相册取图（plan 071）：PHPickerViewController 系统选择器，app 不触碰照片库权限
    /// （免弹权限授权），单选。
    private var photoKey: some View {
        Button {
            showingPhotoPicker = true
        } label: {
            keyCap(label: nil, systemImage: "photo", tint: Theme.foreground, height: 38)
        }
        .disabled(uploading)
        .opacity(uploading ? 0.5 : 1)
        .accessibilityLabel("从相册上传")
        .sheet(isPresented: $showingPhotoPicker) {
            PhotoPicker(isPresented: $showingPhotoPicker) { data, typeIdentifier in
                uploadImage(data: data, typeIdentifier: typeIdentifier, prefix: "photo")
            }
        }
    }

    /// 文件 App 取文件（plan 071）：UIDocumentPickerViewController asCopy: true，
    /// 任意类型单选，原样上传（受 DeviceRouter.maxUploadBytes 前置拦截）。
    private var fileKey: some View {
        Button {
            showingFilePicker = true
        } label: {
            keyCap(label: nil, systemImage: "doc", tint: Theme.foreground, height: 38)
        }
        .disabled(uploading)
        .opacity(uploading ? 0.5 : 1)
        .accessibilityLabel("从文件 App 上传")
        .sheet(isPresented: $showingFilePicker) {
            FilePicker(isPresented: $showingFilePicker) { url in
                uploadFile(url: url)
            }
        }
    }

    /// 回车：最高频主键，竖跨两行大键、primary 高亮、钉右下角；
    /// 顶上是同宽的小退格（右缘列 = 小⌫ + 大⏎）
    private var enterKey: some View {
        Button {
            press("\r")
        } label: {
            Image(systemName: "return")
                .font(Theme.Fonts.label.weight(.semibold))
                .foregroundStyle(Theme.primaryForeground)
                .frame(width: 52, height: 82)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityLabel("回车")
    }

    /// 方向键按下时查激活终端的 DECCKM：应用模式发 SS3（ESC O），否则 CSI（ESC [）
    private func arrowBytes(_ letter: String) -> String {
        let application = task.map { TerminalModeRegistry.shared.applicationCursor(taskID: $0.id) } ?? false
        return (application ? "\u{1b}O" : "\u{1b}[") + letter
    }

    private func press(_ bytes: String) {
        guard let sessionID else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        client.sendInput(sessionID: sessionID, bytes)
    }

    /// 图片上传编排（plan 071）：ImagePipeline.process 是 nonisolated async——await 时
    /// 真正跑在后台线程，大图解码/重编码不占用这里的 MainActor（DictationSession.
    /// requestSpeechPermission 同构手法）。命名单段 `<前缀>-<epoch毫秒>-<短随机><ext>`
    /// （temp 模式 path 只认单段文件名，device.proto:453 注释）。
    private func uploadImage(data: Data, typeIdentifier: String?, prefix: String) {
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

    /// 文件上传编排（plan 071）：asCopy 拿到的沙盒拷贝直接读字节，原文件名只取安全
    /// 扩展名（web safeDropExtension 同原则）。超上限由 CofluxClient.uploadFile→
    /// DeviceRouter.fsWrite 前置拦截并报错，这里不重复判断。
    /// ponytail: Data(contentsOf:) 在 MainActor 上同步读（asCopy 沙盒拷贝，量级
    /// 上限 30MB，本地闪存读取通常 <100ms）；若真机测出卡顿再挪后台线程。
    private func uploadFile(url: URL) {
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

    /// 单段上传文件名（plan 071 命名规则，对照 web terminal-pane.tsx 的 paste-/drop-
    /// 命名）：<前缀>-<epoch毫秒>-<短随机><ext>（ext 含前导点，可为空）。
    private static func uploadName(prefix: String, ext: String) -> String {
        let suffix = String((0 ..< 6).compactMap { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement() })
        return "\(prefix)-\(Int(Date().timeIntervalSince1970 * 1000))-\(suffix)\(ext)"
    }

    /// web safeDropExtension 同原则（terminal-pane.tsx:105-108）：只保留 ASCII 字母数字
    /// 扩展名（1-16 字符），避免奇怪字符拖累 temp 路径；不满足条件直接丢扩展名。
    private static func safeExtension(_ filename: String) -> String {
        guard let dotIndex = filename.lastIndex(of: "."), dotIndex != filename.startIndex else { return "" }
        let ext = filename[filename.index(after: dotIndex)...]
        guard (1 ... 16).contains(ext.count), ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return ""
        }
        return ".\(ext)"
    }

    private func key(
        _ label: String?,
        systemImage: String? = nil,
        tint: Color = Theme.foreground,
        height: CGFloat = 38,
        bytes: @autoclosure @escaping () -> String
    ) -> some View {
        Button {
            press(bytes())
        } label: {
            keyCap(label: label, systemImage: systemImage, tint: tint, height: height)
        }
    }

    /// 可连发键（方向/退格）：按下即发一次（实体键盘语义），按住 0.35s 后
    /// 以 80ms 间隔连发，松手停。
    private func repeatKey(
        systemImage: String,
        height: CGFloat = 38,
        bytes: @autoclosure @escaping () -> String
    ) -> some View {
        keyCap(label: nil, systemImage: systemImage, tint: Theme.foreground, height: height)
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .onLongPressGesture(minimumDuration: 0.35, maximumDistance: 40) {
                guard let sessionID else { return }
                // 连发期间序列求值一次即可（按住途中 DECCKM 不会切换）；
                // 只捕获 Sendable 值跨进 Timer 闭包
                let payload = bytes()
                let client = self.client
                repeatTimer?.invalidate()
                repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
                    Task { @MainActor in client.sendInput(sessionID: sessionID, payload) }
                }
            } onPressingChanged: { pressing in
                if pressing {
                    press(bytes())
                } else {
                    repeatTimer?.invalidate()
                    repeatTimer = nil
                }
            }
    }

    private func keyCap(label: String?, systemImage: String?, tint: Color, height: CGFloat) -> some View {
        Group {
            if let systemImage {
                Image(systemName: systemImage)
            } else {
                Text(label ?? "")
            }
        }
        .font(Theme.Fonts.label.weight(.medium))
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(Theme.secondarySurface, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 相册取图入口（plan 071）：PHPickerViewController 系统选择器，app 不触碰照片库权限
/// （免弹权限授权弹窗）。委托回调不保证在主线程（真机已知坑）：关闭 sheet 与把选中
/// 字节交回调用方都经 Task { @MainActor in } 显式跳回。
struct PhotoPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let onPick: (Data, String?) -> Void

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
        let onPick: (Data, String?) -> Void

        init(isPresented: Binding<Bool>, onPick: @escaping (Data, String?) -> Void) {
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
                Task { @MainActor in onPick(data, typeIdentifier) }
            }
        }
    }
}

/// 文件 App 取文件入口（plan 071）：UIDocumentPickerViewController asCopy: true——
/// 拿到的是沙盒内拷贝，免 startAccessingSecurityScopedResource 配对管理（漏配对读取
/// 直接失败，真机已知坑）。委托回调不保证在主线程，同 PhotoPicker 显式跳回处理。
struct FilePicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let onPick: (URL) -> Void

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
        let onPick: (URL) -> Void

        init(isPresented: Binding<Bool>, onPick: @escaping (URL) -> Void) {
            self.isPresented = isPresented
            self.onPick = onPick
        }

        nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            Task { @MainActor in self.isPresented.wrappedValue = false }
            guard let url = urls.first else { return }
            Task { @MainActor in onPick(url) }
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

/// 成文层（plan 053 最终形态）：与系统键盘同层的输入条（fullScreenCover
/// 透明底、无暗色蒙层——底下的终端与控制板完全冻结可见）。
/// 点输入条外任意处取消（草稿保留）；单行输入，发送/键盘回车 = 仅落文本
/// 不回车（plan 054/055）。
/// 可调强度毛玻璃：暂停的 UIViewPropertyAnimator 用 fractionComplete 控制
/// 模糊深度（0-1 连续），这是"淡毛玻璃"的唯一正确姿势——直接给材质设
/// opacity 会禁用模糊、退化成不透明灰遮罩（真机踩过）。强度渐变自带淡入淡出。
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

struct TerminalComposeOverlay: View {
    @Binding var draft: String
    let onSend: () -> Void
    let onDismiss: () -> Void
    @FocusState private var focused: Bool
    /// 自绘淡入淡出（呈现层动画已禁）：毛玻璃强度与输入条透明度同步渐变
    @State private var appeared = false

    var body: some View {
        ZStack(alignment: .bottom) {
            // 控制中心式清透重糊的最优公开逼近：部分强度下着色层按比例变淡、
            // 模糊保留大半（全强度时内置 tint 拉满会发闷；调研见 plan 053）
            VariableBlurView(intensity: appeared ? 0.65 : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { fadeOutAndDismiss() }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("输入后发送到终端", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit {
                        onSend()
                        fadeOutAndDismiss()
                    }
                    .focused($focused)
                    .font(Theme.Fonts.body)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 8)
                Image(systemName: "arrow.up")
                    .font(Theme.Fonts.label.weight(.bold))
                    .foregroundStyle(draft.isEmpty ? Theme.mutedForeground : Theme.primaryForeground)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(draft.isEmpty ? Theme.secondarySurface : Theme.primary))
                    .onTapGesture {
                        onSend()
                        fadeOutAndDismiss()
                    }
                    .accessibilityLabel("发送")
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border, lineWidth: 0.5))
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
            .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            focused = true
        }
    }

    /// 收场时序：模糊/卡片 ~120ms 淡完 → 系统键盘 ~250ms 落完 → 320ms 时
    /// 才拆呈现层（此刻屏上已无残留，拆除不可见）。提前拆会把淡出中的模糊
    /// 和下落中的键盘硬切掉——"结尾一卡"的根因（真机踩过）。
    private func fadeOutAndDismiss() {
        focused = false
        withAnimation(.easeIn(duration: 0.12)) { appeared = false }
        Task {
            try? await Task.sleep(for: .milliseconds(320))
            onDismiss()
        }
    }
}
