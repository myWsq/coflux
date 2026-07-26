import SwiftUI
import SwiftTerm

/// 激活终端的模式注册表：输入板据此决定方向键序列（DECCKM）与
/// 多行文本是否包 bracketed paste（plan 053）。
@MainActor
final class TerminalModeRegistry {
    static let shared = TerminalModeRegistry()
    private var applicationCursorGetters: [String: () -> Bool] = [:]

    func register(taskID: String, applicationCursor: @escaping () -> Bool) {
        applicationCursorGetters[taskID] = applicationCursor
    }

    func unregister(taskID: String) {
        applicationCursorGetters[taskID] = nil
    }

    func applicationCursor(taskID: String) -> Bool {
        applicationCursorGetters[taskID]?() ?? false
    }
}

/// SwiftTerm TerminalView 的 SwiftUI 宿主。职责：
/// - 按 task.sessionID 绑定/换绑 session consumer（replace 帧先 resetToInitialState 再 feed）
/// - 硬件键盘输入 → client.sendInput；布局变化 → client.resizeSession + 上报 dims 给详情页
/// - RUNNING 任务在绑定时以终端实际 dims 发起 attach（client.startTask 内部路由）
struct TerminalHostView: UIViewRepresentable {
    let client: CofluxClient
    let taskID: String
    let sessionID: String?
    var onSizeChanged: ((UInt32, UInt32) -> Void)?

    /// ANSI 16 色对齐 web xterm theme（terminal-pane.tsx:197-211）。web 未指定的
    /// bright 位沿用 normal 同色（brightBlack/brightWhite 例外），保持双端观感一致。
    private static let webAnsiPalette: [SwiftTerm.Color] = [
        0x1A1A1A, 0xE05C6A, 0x4FAE6E, 0xC9A227, 0x6B9BD1, 0xB07CC6, 0x56B6C2, 0xD4D4D4,
        0x6A6A6A, 0xE05C6A, 0x4FAE6E, 0xC9A227, 0x6B9BD1, 0xB07CC6, 0x56B6C2, 0xFFFFFF,
    ].map { (rgb: UInt32) in
        SwiftTerm.Color(
            red: UInt16((rgb >> 16) & 0xFF) * 257,
            green: UInt16((rgb >> 8) & 0xFF) * 257,
            blue: UInt16(rgb & 0xFF) * 257
        )
    }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        // 纯显示化（plan 053）：inputView 置空视图挡系统键盘（点按不再弹）、
        // 置 nil 去内置快捷条；保留 firstResponder → 长按选择/拷贝、外接硬件
        // 键盘直通不受影响。软键盘输入一律走 TerminalInputArea。
        view.inputView = UIView()
        view.inputAccessoryView = nil
        view.terminalDelegate = context.coordinator
        // 字体/光标/配色对齐 web 终端（bar 光标；iOS 的 monospacedSystemFont
        // 即 SF Mono，与 web 首选字体同族）。字号 13 而非 web 的 12：
        // 手机阅读距离更远，用户实测 12 偏小（2026-07-26）
        view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.backgroundColor = Theme.terminalUIColor
        view.nativeBackgroundColor = Theme.terminalUIColor
        view.nativeForegroundColor = Theme.terminalForegroundUIColor
        view.caretColor = Theme.terminalForegroundUIColor
        view.installColors(Self.webAnsiPalette)
        view.getTerminal().setCursorStyle(.blinkBar)
        context.coordinator.terminalView = view
        return view
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        context.coordinator.taskID = taskID
        context.coordinator.bind(sessionID: sessionID)
        TerminalModeRegistry.shared.register(taskID: taskID) { [weak uiView] in
            uiView?.getTerminal().applicationCursor ?? false
        }
    }

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        coordinator.release()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(client: client, taskID: taskID, onSizeChanged: onSizeChanged)
    }

    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        private let client: CofluxClient
        var taskID: String
        private let onSizeChanged: ((UInt32, UInt32) -> Void)?
        weak var terminalView: TerminalView?
        private var boundSessionID: String?
        private var releaseConsumer: (() -> Void)?

        init(client: CofluxClient, taskID: String, onSizeChanged: ((UInt32, UInt32) -> Void)?) {
            self.client = client
            self.taskID = taskID
            self.onSizeChanged = onSizeChanged
        }

        func bind(sessionID: String?) {
            guard sessionID != boundSessionID else { return }
            releaseConsumer?()
            releaseConsumer = nil
            boundSessionID = sessionID
            guard let sessionID, let terminalView else { return }
            releaseConsumer = client.registerSessionConsumer(sessionID: sessionID) { [weak terminalView] data, replace in
                guard let terminalView else { return }
                if replace { terminalView.getTerminal().resetToInitialState() }
                terminalView.feed(byteArray: ArraySlice([UInt8](data)))
            }
            let terminal = terminalView.getTerminal()
            client.startTask(taskID: taskID, cols: UInt32(terminal.cols), rows: UInt32(terminal.rows))
        }

        func release() {
            TerminalModeRegistry.shared.unregister(taskID: taskID)
            releaseConsumer?()
            releaseConsumer = nil
            boundSessionID = nil
        }

        // MARK: - TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            guard let sessionID = boundSessionID,
                  let text = String(bytes: data, encoding: .utf8) else { return }
            client.sendInput(sessionID: sessionID, text)
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            guard newCols > 0, newRows > 0 else { return }
            let cols = UInt32(newCols)
            let rows = UInt32(newRows)
            onSizeChanged?(cols, rows)
            if let sessionID = boundSessionID {
                client.resizeSession(sessionID: sessionID, cols: cols, rows: rows)
            }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link), url.scheme == "https" || url.scheme == "http" {
                UIApplication.shared.open(url)
            }
        }
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                UIPasteboard.general.string = text
            }
        }
        func clipboardRead(source: TerminalView) -> Data? {
            UIPasteboard.general.string?.data(using: .utf8)
        }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
