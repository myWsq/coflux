import SwiftUI
import SwiftTerm

/// SwiftTerm TerminalView 的 SwiftUI 宿主。职责：
/// - 按 task.sessionID 绑定/换绑 session consumer（replace 帧先 resetToInitialState 再 feed）
/// - 键盘输入 → client.sendInput；布局变化 → client.resizeSession + 上报 dims 给详情页
/// - RUNNING 任务在绑定时以终端实际 dims 发起 attach（client.startTask 内部路由）
/// 快捷键条用 SwiftTerm 内置 TerminalAccessory（Esc/Ctrl/Tab/箭头，iOSTerminalView 自装）。
struct TerminalHostView: UIViewRepresentable {
    let client: CofluxClient
    let taskID: String
    let sessionID: String?
    var onSizeChanged: ((UInt32, UInt32) -> Void)?

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.backgroundColor = .black
        context.coordinator.terminalView = view
        return view
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        context.coordinator.taskID = taskID
        context.coordinator.bind(sessionID: sessionID)
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
